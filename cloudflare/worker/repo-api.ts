// Public API of the YonedaRepo source platform (`/api/v1`). A thin adapter: it
// authenticates, maps routes onto the shared operation table, and forwards commands to
// the repository's SourceRepository Durable Object, which owns every decision. Callers
// are workspace sessions (owners) or repository tokens (agents, CI, scripts) — all the
// same to us.

import { accountMcp } from './account-mcp';
import { authenticate } from './auth';
import { error, readJson, response } from './http';
import { deviceApprove, deviceCode, deviceToken, tokenRoute } from './platform-tokens';
import { deleteRepository, listRepositories } from './repo-admin';
import { breakGlass } from './repo-break-glass';
import { changeLogStatus } from './repo-changelog';
import { createRepository, importRepository, tokenSecret } from './repo-create';
import { refreshHead } from './repo-head';
import { repoMcp } from './repo-mcp';
import { parseStore } from './repo-objects';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { verifyPat } from './repo-pat';
import { timed, withTimings } from './repo-timing';
import { operations } from './repo-tools';
import { vacuum } from './repo-vacuum';
import { humanView } from './repo-views';
import type { Env } from './types';

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  CONFLICT: 409,
  MERGE_REQUIRED: 409,
  STALE_PARENT: 409,
  NOT_READY: 409,
  STALE_HEAD: 409,
  STALE_EPOCH: 409,
  NOT_LANDED: 409,
  AUTOMATION_PAUSED: 423,
  ALREADY_EXISTS: 409,
  PUSH_FAILED: 502,
  NOT_SUPPORTED: 400,
  TIMEOUT: 503,
  STALE_HANDLE: 409,
  PARSE_FAILED: 422,
  GONE: 404,
  RATE_LIMITED: 429,
};
export const statusOf = (code: string, known: boolean) => STATUS[code] ?? (known ? 400 : 500);
const COMMIT_BODY_LIMIT = 64 * 1024 * 1024;
const bodyOf = (req: Request, limit?: number) =>
  readJson(req, limit).catch((e) => {
    throw new ApiError('INVALID_INPUT', String(e?.message ?? e));
  });

/** Session checks in flight in this isolate, by everything `authenticate` reads: requests
 * with identical credentials arriving together share one check (no result outlives it). */
const checking = new Map<string, ReturnType<typeof authenticate>>();
function authenticateOnce(req: Request, env: Env) {
  const key = JSON.stringify(
    ['origin', 'authorization', 'cookie', 'cf-access-jwt-assertion'].map((h) => req.headers.get(h)),
  ).concat(new URL(req.url).origin);
  let check = checking.get(key);
  if (!check) {
    check = authenticate(req, env).finally(() => checking.delete(key));
    checking.set(key, check);
  }
  return check;
}

/** The caller of a platform request: a repository token, a personal access token (checked
 * with its account on every request), or a workspace session; null when none is valid. */
export async function credentials(req: Request, env: Env): Promise<Credentials | null> {
  const bearer = req.headers.get('authorization');
  if (bearer?.startsWith('Bearer yrp_')) return { _token: bearer.slice(7) };
  if (bearer?.startsWith('Bearer ypat_')) {
    const grant = await verifyPat(env, bearer.slice(7));
    return grant && { _pat: grant };
  }
  const principal = await authenticateOnce(req, env);
  if (!principal || principal.role === 'agent') return null;
  const name = principal.role === 'admin' ? 'admin' : `user:${principal.workspace}`;
  // Only a personal account session is a person; admin bearers may be held by scripts.
  const human = principal.role === 'user' ? { human: true as const } : {};
  return { _session: { workspace: principal.workspace, principal: name, ...human } };
}

export async function route(req: Request, env: Env, url: URL, auth: Credentials): Promise<Json> {
  const parts = url.pathname.split('/').filter(Boolean).slice(2); // after api/v1
  if (parts[0] === 'tokens' && parts.length <= 2)
    return tokenRoute(env, auth, req.method, parts[1], () => bodyOf(req));
  if (
    parts[0] === 'device' &&
    parts[1] === 'approve' &&
    parts.length === 2 &&
    req.method === 'POST'
  )
    return deviceApprove(env, auth, await bodyOf(req));
  if (parts[0] !== 'repos') throw new ApiError('NOT_FOUND', 'Unknown API path');
  if (parts.length === 1 && req.method === 'POST')
    return createRepository(env, auth, await bodyOf(req, COMMIT_BODY_LIMIT));
  if (parts.length === 2 && parts[1] === 'import' && req.method === 'POST')
    return importRepository(env, auth, await bodyOf(req));
  if (parts.length === 1 && req.method === 'GET') return listRepositories(env, auth);
  const repo = parts[1];
  if (!/^r[0-9a-f]{20}$/.test(repo ?? '')) throw new ApiError('NOT_FOUND', 'Unknown repository');
  const ctx = new RepoContext(env, repo, caller(env, repo, auth));
  const [resource, sha, sub] = parts.slice(2);
  const get = req.method === 'GET';
  const post = req.method === 'POST';
  const query = Object.fromEntries(url.searchParams);
  const run = (name: string, args: Json) => operations[name](ctx, args);
  if (!resource && req.method === 'DELETE')
    return deleteRepository(env, auth, repo, url.searchParams.get('confirm') ?? '');
  if (resource === 'refs' && sha === 'batch' && !sub && post)
    return batchRefs(ctx, await bodyOf(req));
  if (!resource && get) return run('git_status', {});
  if (get && resource === 'refs') return run('git_refs', query);
  if (get && resource === 'log') return run('git_log', query);
  if (get && resource === 'txlog') return run('git_txlog', query);
  if (get && resource === 'changelog') return changeLogStatus(ctx);
  if (get && resource === 'merge-base') return run('git_merge_base', query);
  if (get && resource === 'tree') return run('git_ls_tree', query);
  if (get && resource === 'blob') return run('git_cat_file', query);
  if (get && resource === 'search')
    return run('git_grep', { ...query, ignore_case: query.ignore_case === 'true' });
  if (get && resource === 'blame') return run('git_blame', query);
  if (get && resource === 'symbols') return run('symbol_list', query);
  if (get && resource === 'symbol') return run('symbol_get', query);
  if (get && resource === 'contract') return run('symbol_contract', query);
  if (resource === 'contracts' && post) return run('symbol_contract_record', await bodyOf(req));
  if (get && resource === 'views' && sha === 'agent') return run('symbol_view', query);
  if (get && resource === 'views' && sha === 'human') return humanView(ctx, query);
  if (resource === 'symbol-edits' && post)
    return run('symbol_edit', await bodyOf(req, COMMIT_BODY_LIMIT));
  if (resource === 'codemods' && post) return run('git_codemod', await bodyOf(req));
  if (resource === 'plans' && post) return run('git_plan', await bodyOf(req));
  if (resource === 'bisect' && post) return run('git_bisect', await bodyOf(req));
  if (resource === 'bisect' && sha && get) return run('git_bisect', { id: sha });
  if (resource === 'commits' && sha && sub === 'pin' && post)
    return run('git_pin', { ...(await bodyOf(req)), commit: sha });
  if (resource === 'vacuum' && post) return vacuum(ctx, await bodyOf(req).catch(() => ({})));
  if (get && resource === 'diff')
    return run('git_diff', {
      ...query,
      patch: query.patch === '1' || query.patch === 'true',
      merge_base: query.merge_base === '1' || query.merge_base === 'true',
    });
  if (resource === 'commits' && sha && !sub && get) return run('git_show', { commit: sha });
  if (resource === 'commits' && !sha && post)
    return run('git_commit', await bodyOf(req, COMMIT_BODY_LIMIT));
  if (resource === 'commits' && sha && sub === 'checks' && post)
    return run('git_check', { ...(await bodyOf(req)), commit: sha });
  if (resource === 'commits' && sha && sub === 'reviews' && post)
    return run('git_review', { ...(await bodyOf(req)), commit: sha });
  if (resource === 'commits' && sha && sub === 'revert' && post)
    return run('git_revert', { ...(await bodyOf(req).catch(() => ({}))), commit: sha });
  if (resource === 'commits' && sha && sub === 'cherry-pick' && post)
    return run('git_cherry_pick', { ...(await bodyOf(req).catch(() => ({}))), commit: sha });
  if (resource === 'commits' && sha && sub === 'check-runs' && post)
    return run('git_check_run', { ...(await bodyOf(req).catch(() => ({}))), commit: sha });
  if (resource === 'check-runs' && sha && get) {
    const detail = await ctx.call({ op: 'repo_check_run', run_id: sha });
    if (sub !== 'log') return detail;
    const key = detail.result?.log;
    // The key is ours (built per repository by the executor), but never trust stored state.
    if (typeof key !== 'string' || !key.startsWith(`platform/v1/${repo}/checks/${sha}/`))
      throw new ApiError('NOT_FOUND', 'This run has no log');
    const log = await env.OBJECTS.get(key);
    if (!log) throw new ApiError('NOT_FOUND', 'This run has no log');
    return { run_id: sha, log: await log.text() };
  }
  if (resource === 'import' && get) {
    await ctx.call({ op: 'repo_status' }); // read access first
    const status = await env.PLATFORM_IMPORT.get(`import-${repo}`).then((i) => i.status());
    return { import: `import-${repo}`, ...status };
  }
  // Access changes republish main's head (begins and reads decide access from it).
  if (resource === 'policy' && req.method === 'PUT')
    return withHeadRefresh(
      env,
      repo,
      ctx.call({ op: 'repo_set_policy', policy: (await bodyOf(req)).policy }),
    );
  if (resource === 'objects' && post)
    return run('git_get_objects', await bodyOf(req, 2 * 1024 * 1024));
  if (resource === 'merges' && post) return run('git_merge', await bodyOf(req));
  // The landing mode is chosen per request only where the deployment allows it.
  if (resource === 'land' && post)
    return run('git_land', {
      ...(await bodyOf(req)),
      land_mode: req.headers.get('x-yoneda-land-mode'),
    });
  if (resource === 'branches' && post) return run('git_branch', await bodyOf(req));
  if (resource === 'break-glass' && post) return breakGlass(ctx, await bodyOf(req));
  if (resource === 'clone' && post) {
    // The authority admits only a person who can read the whole repository.
    const access = await ctx.call({ op: 'repo_clone_access' });
    const store = parseStore(env, access.object_store);
    if (!store.cloneAccess)
      throw new ApiError('NOT_SUPPORTED', "This repository's object store cannot be cloned");
    return store.cloneAccess();
  }
  if (resource === 'tokens' && get) return ctx.call({ op: 'repo_tokens' });
  if (resource === 'tokens' && !sha && post) {
    const body = await bodyOf(req);
    const secret = tokenSecret();
    const created = await withHeadRefresh(
      env,
      repo,
      ctx.call({
        op: 'repo_token_create',
        name: body.name,
        scopes: body.scopes,
        paths: body.paths ?? null,
        _secret: secret,
      }),
    );
    return { ...created, token: secret };
  }
  if (resource === 'tokens' && sha && req.method === 'DELETE')
    return withHeadRefresh(env, repo, ctx.call({ op: 'repo_token_revoke', name: sha }));
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}

/** `POST refs/batch`: every branch moves or none; stale expectations answer 409 naming
 * the stale refs (`details.stale`). */
async function batchRefs(ctx: RepoContext, body: Json) {
  if (!Array.isArray(body.updates))
    throw new ApiError('INVALID_INPUT', 'updates must be a list of {ref, commit, expected}');
  const result = await ctx.call({
    op: 'repo_branch_batch',
    updates: body.updates.map((u: Json) => ({
      ref: u?.ref,
      commit: u?.commit,
      expected: u?.expected ?? null,
    })),
  });
  if (result.stale)
    throw new ApiError('STALE_HEAD', `Stale expected heads: ${result.stale.join(', ')}`, {
      stale: result.stale,
    });
  return { version: result.version, refs: result.refs };
}

async function withHeadRefresh(env: Env, repo: string, change: Promise<Json>) {
  const done = await change;
  await refreshHead(env, repo);
  return done;
}

export async function repoApi(req: Request, env: Env): Promise<Response> {
  const { value, header } = await withTimings(() => handle(req, env));
  if (header) value.headers.set('server-timing', header);
  return value;
}

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  // Device login starts and finishes without credentials (the code pair is the secret).
  if (req.method === 'POST' && url.pathname === '/api/v1/device/code')
    return answer(() => bodyOf(req).then((body) => deviceCode(req, env, body, url)));
  if (req.method === 'POST' && url.pathname === '/api/v1/device/token')
    return answer(() => bodyOf(req).then((body) => deviceToken(req, env, body)));
  const auth = await timed('auth', () => credentials(req, env));
  if (!auth) return error('UNAUTHORIZED', 'Sign in or use a repository token', 401);
  const mcp = /^\/api\/v1\/repos\/(r[0-9a-f]{20})\/mcp$/.exec(url.pathname);
  // MCP is the agent surface: it never carries a human marker, so break-glass (which is not
  // an MCP tool either) stays unreachable through it.
  const machine: Credentials =
    '_session' in auth
      ? { _session: { workspace: auth._session.workspace, principal: auth._session.principal } }
      : auth;
  if (mcp) return repoMcp(req, new RepoContext(env, mcp[1], caller(env, mcp[1], machine)));
  if (url.pathname === '/api/v1/mcp') return accountMcp(req, env, machine, route);
  return answer(() => route(req, env, url, auth));
}

/** A JSON answer, or the API error a failure maps to. */
async function answer(run: () => Promise<Json>): Promise<Response> {
  try {
    return response(await run());
  } catch (e: any) {
    const code = e instanceof ApiError ? e.code : (e?.code ?? 'INVALID_INPUT');
    const message = String(e?.message ?? e).slice(0, 500);
    const status = statusOf(code, e instanceof ApiError || !!e?.code);
    if (e instanceof ApiError && e.details)
      return response({ error: { code, message, details: e.details } }, status);
    return error(code, message, status);
  }
}
