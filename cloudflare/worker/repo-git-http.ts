// Stock Git over HTTPS (smart HTTP, stateless RPC) at /git/<repo>.git: clone and fetch
// (upload-pack; protocol version 2 when Git asks for it, with partial and shallow clones)
// and push (receive-pack, version 0) without the remote helper. Credentials are a
// repository or personal token as the Basic password (any user name) or a bearer header;
// a 401 asks Git's credential helper for one. The SSH gateway's session token (`ysh_`, a
// bearer) holds for its one repository and service only (platform-ssh.ts). The authority
// decides access per request: read to fetch, write to push, and never a path-restricted grant.
// Git asks without credentials first: that request is anonymous (repo-public.ts), which
// fetches a public repository; anything else it is refused is a 401, so Git then offers
// its credentials, and a private repository looks the same as one that does not exist.

import { failureCode, RETRY_AFTER_SECONDS } from './durable';
import { sshBearer, verifySshToken } from './platform-ssh';
import { credentials } from './repo-api';
import { compute } from './repo-compute';
import { receivePack } from './repo-git-receive';
import { PackStats, uploadPack } from './repo-git-upload';
import { advertiseV2, uploadPackV2, wantsV2 } from './repo-git-v2';
import { guardInherited } from './repo-inherit';
import { isLfsPath, lfsHttp } from './repo-lfs';
import { fromBase64 } from './repo-objects';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { ANONYMOUS, admitAnonymous, limitAnonymous } from './repo-public';
import { timed, withTimings } from './repo-timing';
import type { Env } from './types';

const PATH = /^\/git\/(r[0-9a-f]{20})(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const SERVICES = ['git-upload-pack', 'git-receive-pack'];
const STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  QUARANTINED: 451,
  GONE: 404,
  RATE_LIMITED: 429,
  OVERLOADED: 503,
};

/** A plain-text refusal Git shows as `remote: <message>`; a 401 invites credentials and a
 * 503 says when to try again. */
export function refusal(status: number, message: string) {
  const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
  if (status === 401) headers['www-authenticate'] = 'Basic realm="YonedaRepo"';
  if (status === 503) headers['retry-after'] = String(RETRY_AFTER_SECONDS);
  return new Response(`${message}\n`, { status, headers });
}

/** The caller: a token as the Basic password, or any credential `credentials` accepts;
 * anonymous without any (rate limited per address). */
export async function gitCredentials(req: Request, env: Env): Promise<Credentials | null> {
  const header = req.headers.get('authorization') ?? '';
  if (!header) {
    await limitAnonymous(env, req, new URL(req.url).pathname);
    return ANONYMOUS;
  }
  if (!/^basic /i.test(header)) return credentials(req, env);
  let password = '';
  try {
    const decoded = atob(header.slice(6).trim());
    password = decoded.slice(decoded.indexOf(':') + 1);
  } catch {
    return null;
  }
  if (!/^(yrp|ypat)_/.test(password)) return null;
  return credentials(
    new Request(req.url, { headers: { authorization: `Bearer ${password}` } }),
    env,
  );
}

/** Serves a `/git/` request, or answers why it cannot, with its phases in Server-Timing
 * (Git shows response headers under `GIT_TRACE_CURL=1`). */
export async function gitHttp(req: Request, env: Env): Promise<Response> {
  const { value, header } = await withTimings(() => serve(req, env));
  if (header) value.headers.set('server-timing', header);
  return value;
}

async function serve(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  // Git LFS (repo-lfs.ts) under the same URL and credentials.
  if (isLfsPath(url.pathname)) return lfsHttp(req, env, gitCredentials);
  const match = PATH.exec(url.pathname);
  if (!match) return refusal(404, 'Not a Git repository URL: use /git/<repository id>.git');
  const [, repo, action] = match;
  const service = action === 'info/refs' ? url.searchParams.get('service') : action;
  if (!service || !SERVICES.includes(service))
    return refusal(403, 'Only smart HTTP is served (Git 1.6.6 or newer)');
  if ((action === 'info/refs') !== (req.method === 'GET'))
    return refusal(405, `${req.method} is not allowed here`);
  const ssh = sshBearer(req);
  let auth: Credentials | null;
  try {
    auth = await timed('git.auth', () =>
      ssh ? verifySshToken(env, ssh, repo, service) : gitCredentials(req, env),
    );
  } catch (e: any) {
    return refusal(STATUS[failureCode(e)] ?? 500, String(e?.message ?? e));
  }
  if (!auth) return refusal(401, 'Use a repository or personal access token as the password');
  const anonymous = '_anonymous' in auth;
  const ctx = new RepoContext(env, repo, caller(env, repo, auth));
  try {
    if (anonymous) await admitAnonymous(env, repo);
    // Access first, so a refusal is an HTTP status Git reports, not a broken protocol.
    const access = await ctx.call({ op: 'repo_git_access', service });
    const objects = ctx.adopt(access.object_store, access.quarantined);
    const v2 = service === 'git-upload-pack' && wantsV2(req);
    if (action === 'info/refs') return v2 ? advertiseV2() : await advertise(ctx, service);
    const body = requestBody(req);
    if (service === 'git-receive-pack') {
      // What a push omits must be held already; a fork's inherited objects count only for
      // readers of its parent (repo-inherit).
      guardInherited(ctx, objects);
      return await receivePack(ctx, objects, body, access.secret_allow ?? []);
    }
    // A client asking for timings gets them after the pack (PackStats).
    const stats = req.headers.get('x-yoneda-timing') === '1' ? new PackStats() : undefined;
    return v2
      ? await uploadPackV2(ctx, objects, body, stats)
      : await uploadPack(ctx, objects, body, stats);
  } catch (e: any) {
    // A push refused because the authority was overloaded moved nothing (receivePack
    // throws only then), so Git gets a status it reports instead of a per-ref refusal.
    const code = failureCode(e);
    // Without credentials, a refusal invites them (a push, or a repository that is private
    // or missing: the same answer, so existence does not leak).
    if (anonymous && ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'GONE'].includes(code))
      return refusal(401, 'Use a repository or personal access token as the password');
    const status = STATUS[code] ?? (e instanceof ApiError ? 400 : 500);
    if (status >= 500) console.error(`git ${service} failed: ${code}`);
    return refusal(status, `${code}: ${String(e?.message ?? e).slice(0, 500)}`);
  }
}

/** First-parent heads of main a push lists as `.have`: the newest, then sparser ones. */
const RECENT = 64;
const HISTORY = 200;

async function advertise(ctx: RepoContext, service: string) {
  const { refs, annotated } = await ctx.call({ op: 'repo_refs' });
  let haves: string[] = [];
  if (service === 'git-receive-pack' && refs['refs/heads/main']) {
    const log = await ctx.call({ op: 'repo_log', ref: 'main', limit: HISTORY });
    haves = (log.commits as Json[])
      .map((c) => c.commit as string)
      .filter((_, i) => i < RECENT || Number.isInteger(Math.log2(i)));
  }
  const { body_b64 } = compute({ op: 'git_advertise', service, refs, annotated, haves });
  return new Response(fromBase64(body_b64), {
    headers: {
      'content-type': `application/x-${service}-advertisement`,
      'cache-control': 'no-cache',
    },
  });
}

/** The request body, inflated when Git compressed it. */
/** A Git request's body, gunzipped when Git compressed it (it does past a few KiB). */
export function requestBody(req: Request): ReadableStream<Uint8Array> {
  const body = req.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  return req.headers.get('content-encoding') === 'gzip'
    ? body.pipeThrough(new DecompressionStream('gzip'))
    : body;
}
