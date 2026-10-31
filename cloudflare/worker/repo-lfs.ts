// Git LFS at /git/<repo>.git/info/lfs: the Batch API with the `basic` transfer adapter, a
// verify action, and the locks endpoints answered without locking. The authority
// (repo_store/lfs.rs) decides access (`read` downloads, `write` uploads, whole repository
// only), the quota and which objects a repository holds; this adapter hands out presigned
// R2 URLs (repo-s3-presign.ts) so object bytes never pass through a Worker. An upload URL signs
// `x-amz-checksum-sha256` (the oid), so R2 refuses other bytes; verify then checks the
// stored object's size and sha256 again before the authority records it. Objects live at
// `platform/v1/<repo>/lfs/<oid>`, under the repository's prefix, so its purge removes them;
// bytes no object references any more are swept before that (repo-lfs-sweep.ts).
// Credentials are those of smart HTTP (a token as the Basic password, or a bearer header);
// without any, a public repository's objects download anonymously (repo-public.ts).
// A fork serves the LFS objects it inherits to readers of its parent (repo-lfs-inherit.ts).
//
// Locks: stock clients ask `POST locks/verify` before every push and `GET locks` for
// `git lfs locks`. Both answer empty lists (no file is ever locked); creating a lock is
// refused with 501 and unlocking answers 404, each with a message `git lfs` shows.
import { failureCode, RETRY_AFTER_SECONDS } from './durable';
import { toHex } from './hmac';
import { readJson } from './http';
import { inheritObjects } from './repo-lfs-inherit';
import { lfsKey, scheduleSweep, sweepLfs } from './repo-lfs-sweep';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { admitAnonymous } from './repo-public';
import { presign, type S3Credentials } from './repo-s3-presign';
import type { Env } from './types';

const PATH = /^\/git\/(r[0-9a-f]{20})(?:\.git)?\/info\/lfs\/(.+)$/;
const MEDIA = 'application/vnd.git-lfs+json';
/** How long a presigned URL may start a transfer. */
export const URL_SECONDS = 3600;
const BATCH_BODY = 256 * 1024;
const OID = /^[0-9a-f]{64}$/;

const STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  GONE: 404,
  CONFLICT: 409,
  TOO_LARGE: 413,
  INVALID_INPUT: 422,
  RATE_LIMITED: 429,
  NOT_CONFIGURED: 501,
  OVERLOADED: 503,
  QUOTA_EXCEEDED: 507,
  REPO_FULL: 507,
};

export const isLfsPath = (pathname: string) => PATH.test(pathname);
export { lfsKey };

const answer = (value: Json, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': MEDIA, 'cache-control': 'no-store' },
  });

/** An LFS error body (`message` is what `git lfs` prints); a 401 asks for credentials. */
export function lfsError(status: number, message: string) {
  const refused = answer({ message }, status);
  if (status === 401) {
    refused.headers.set('lfs-authenticate', 'Basic realm="YonedaRepo"');
    refused.headers.set('www-authenticate', 'Basic realm="YonedaRepo"');
  }
  if (status === 429 || status === 503)
    refused.headers.set('retry-after', String(RETRY_AFTER_SECONDS));
  return refused;
}

/** The R2 S3 credentials presigned URLs are signed with; null where LFS is not set up. */
export function s3Credentials(env: Env): S3Credentials | null {
  const { LFS_S3_ENDPOINT, LFS_S3_BUCKET, LFS_S3_ACCESS_KEY_ID, LFS_S3_SECRET_ACCESS_KEY } = env;
  if (!LFS_S3_ENDPOINT || !LFS_S3_BUCKET || !LFS_S3_ACCESS_KEY_ID || !LFS_S3_SECRET_ACCESS_KEY)
    return null;
  return {
    endpoint: LFS_S3_ENDPOINT,
    bucket: LFS_S3_BUCKET,
    accessKeyId: LFS_S3_ACCESS_KEY_ID,
    secretAccessKey: LFS_S3_SECRET_ACCESS_KEY,
  };
}

const body = (req: Request, limit?: number) =>
  readJson(req, limit).catch((e) => {
    throw new ApiError('INVALID_INPUT', String(e?.message ?? e));
  });

/** Serves an `/info/lfs/` request with the caller `authenticate` finds (smart HTTP's). */
export async function lfsHttp(
  req: Request,
  env: Env,
  authenticate: (req: Request, env: Env) => Promise<Credentials | null>,
): Promise<Response> {
  const url = new URL(req.url);
  const match = PATH.exec(url.pathname);
  if (!match) return lfsError(404, 'Not a Git LFS URL');
  const [, repo, action] = match;
  const auth = await authenticate(req, env).catch((e) => e as Error);
  if (auth instanceof Error) {
    const code = failureCode(auth);
    return lfsError(STATUS[code] ?? 500, `${code}: ${auth.message}`);
  }
  if (!auth) return lfsError(401, 'Use a repository or personal access token as the password');
  const ctx = new RepoContext(env, repo, caller(env, repo, auth));
  const post = req.method === 'POST';
  try {
    if ('_anonymous' in auth) await admitAnonymous(env, repo);
    if (action === 'objects/batch' && post) return await batch(ctx, req, url);
    if (action === 'verify' && post) return await verify(ctx, req);
    if (action === 'locks' && req.method === 'GET') {
      await access(ctx, false);
      return answer({ locks: [] });
    }
    if (action === 'locks/verify' && post) {
      await access(ctx, true);
      return answer({ ours: [], theirs: [] });
    }
    if (action === 'locks' && post) {
      await access(ctx, true);
      return lfsError(501, 'File locking is not supported: YonedaRepo merges concurrent changes');
    }
    if (/^locks\/[^/]+\/unlock$/.test(action) && post) {
      await access(ctx, true);
      return lfsError(404, 'No such lock: YonedaRepo does not lock files');
    }
    return lfsError(404, 'Unknown Git LFS endpoint');
  } catch (e: any) {
    const code = failureCode(e);
    // Without credentials, a refusal invites them, as smart HTTP's does (repo-git-http.ts).
    if ('_anonymous' in auth && ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'GONE'].includes(code))
      return lfsError(401, 'Use a repository or personal access token as the password');
    const status = STATUS[code] ?? (e instanceof ApiError ? 400 : 500);
    if (status >= 500 && status !== 501 && status !== 507) console.error(`git lfs failed: ${code}`);
    return lfsError(status, `${code}: ${String(e?.message ?? e).slice(0, 500)}`);
  }
}

/** Smart HTTP's access decision: `read` (or `write`) on the whole repository. */
const access = (ctx: RepoContext, write: boolean) =>
  ctx.call({ op: 'repo_git_access', service: write ? 'git-receive-pack' : 'git-upload-pack' });

/** The base64 sha256 S3 checksum headers carry, of a hex oid. */
const checksum = (oid: string) =>
  btoa(String.fromCharCode(...(oid.match(/../g) ?? []).map((h) => Number.parseInt(h, 16))));

/** `POST objects/batch`: an action per object the caller may move, or why not. */
async function batch(ctx: RepoContext, req: Request, url: URL): Promise<Response> {
  const request = await body(req, BATCH_BODY);
  const { operation, objects, transfers, hash_algo } = request;
  if (operation !== 'upload' && operation !== 'download')
    return lfsError(422, 'operation must be upload or download');
  if (!Array.isArray(objects)) return lfsError(422, 'objects must be a list');
  if (Array.isArray(transfers) && !transfers.includes('basic'))
    return lfsError(422, 'Only the basic transfer adapter is served');
  if (hash_algo !== undefined && hash_algo !== 'sha256')
    return lfsError(409, 'Only sha256 object ids are served');
  const creds = s3Credentials(ctx.env);
  if (!creds) return lfsError(501, 'Git LFS is not configured on this deployment');
  const decided = await ctx.call({
    op: 'repo_lfs_batch',
    operation,
    objects: objects.map((o: Json) => ({ oid: o?.oid, size: o?.size })),
  });
  // Lapsed reservations' bytes, and new ones once they lapse, are the sweep's (repo-lfs-sweep).
  await scheduleSweep(ctx.env, ctx.repo, decided.sweep_at);
  // A fork's missing objects may be its parent's, for callers who read the parent.
  if (decided.parent) await inheritObjects(ctx, decided);
  const verifyHref = `${url.origin}/git/${ctx.repo}.git/info/lfs/verify`;
  const actions = await Promise.all(
    (decided.objects as Json[]).map(async (o): Promise<Json> => {
      const { oid, size } = o;
      if (o.error) return { oid, size, error: o.error };
      const key = lfsKey(o.holder ?? ctx.repo, oid);
      if (o.present && operation === 'upload') return { oid, size };
      if (o.present) {
        const href = await presign(creds, 'GET', key, URL_SECONDS);
        return {
          oid,
          size,
          authenticated: true,
          actions: { download: { href, expires_in: URL_SECONDS } },
        };
      }
      const header = { 'x-amz-checksum-sha256': checksum(oid) };
      const href = await presign(creds, 'PUT', key, URL_SECONDS, header);
      return {
        oid,
        size,
        authenticated: true,
        actions: {
          upload: { href, header, expires_in: URL_SECONDS },
          verify: { href: verifyHref, expires_in: URL_SECONDS },
        },
      };
    }),
  );
  return answer({ transfer: 'basic', objects: actions, hash_algo: 'sha256' });
}

/** The stored object's sha256: R2's recorded checksum, else hashed from its bytes. */
async function storedSha256(env: Env, key: string, head: R2Object) {
  const recorded = head.checksums.sha256;
  if (recorded) return toHex(recorded);
  const object = await env.OBJECTS.get(key);
  if (!object) return null;
  const digest = new crypto.DigestStream('SHA-256');
  await object.body.pipeTo(digest);
  return toHex(await digest.digest);
}

/** Forgets a reservation whose bytes failed verification (or no longer fit): the authority
 * queues the bytes for the sweep (unless the object is stored after all), which is
 * scheduled and then run at once, so they are gone before verify answers. Should that run
 * fail, the scheduled one deletes them. */
async function discard(ctx: RepoContext, oid: string) {
  const { sweep_at } = await ctx.call({ op: 'repo_lfs_discard', oid });
  await scheduleSweep(ctx.env, ctx.repo, sweep_at);
  await sweepLfs(ctx.env, ctx.repo).catch((e) =>
    console.warn(`lfs sweep after discard failed: ${e?.message ?? e}`),
  );
}

/** `POST verify {oid, size}`: after an upload, the stored bytes are checked (size and
 * sha256 = oid) and the object recorded; bytes that fail are deleted. */
async function verify(ctx: RepoContext, req: Request): Promise<Response> {
  const { oid, size } = await body(req);
  if (typeof oid !== 'string' || !OID.test(oid) || !Number.isSafeInteger(size) || size < 0)
    return lfsError(422, 'verify needs the oid (sha256) and size of an uploaded object');
  await access(ctx, true);
  const key = lfsKey(ctx.repo, oid);
  const head = await ctx.env.OBJECTS.head(key);
  if (!head) return lfsError(404, `Object ${oid} was not uploaded`);
  const sha256 = head.size === size ? await storedSha256(ctx.env, key, head) : null;
  const problem =
    head.size !== size
      ? `${head.size} bytes were stored, not ${size}`
      : sha256 !== oid
        ? 'the stored bytes do not hash to the oid'
        : null;
  if (problem) {
    await discard(ctx, oid);
    return lfsError(422, `Object ${oid} failed verification (${problem}); upload it again`);
  }
  try {
    await ctx.call({ op: 'repo_lfs_store', oid, size });
  } catch (e: any) {
    if (e instanceof ApiError && e.code === 'QUOTA_EXCEEDED') await discard(ctx, oid);
    throw e;
  }
  return answer({ oid, size });
}

/** `GET /api/v1/repos/:id/lfs` (quota and usage) and `PUT` with `{quota_bytes}` (owner). */
export async function lfsRoute(
  ctx: RepoContext,
  method: string,
  read: () => Promise<Json>,
): Promise<Json> {
  if (method === 'GET') return ctx.call({ op: 'repo_lfs_usage' });
  if (method === 'PUT')
    return ctx.call({ op: 'repo_lfs_set_quota', quota_bytes: (await read()).quota_bytes });
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}
