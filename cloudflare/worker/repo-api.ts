// Public API of the YonedaRepo source platform (`/api/v1`). A thin adapter: it
// authenticates, maps routes onto the shared operation table, and forwards commands to
// the repository's SourceRepository Durable Object, which owns every decision. Callers
// are workspace sessions (owners) or repository tokens (agents, CI, scripts) — all the
// same to us.
import { authenticate } from './auth';
import { error, readJson, response } from './http';
import { repoMcp } from './repo-mcp';
import { newStore, RepoObjects, toBase64 } from './repo-objects';
import { ApiError, type Credentials, caller, commit, type Json, RepoContext } from './repo-ops';
import { operations } from './repo-tools';
import type { Env } from './types';

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  CONFLICT: 409,
  MERGE_REQUIRED: 409,
  STALE_PARENT: 409,
  NOT_READY: 409,
  ALREADY_EXISTS: 409,
  PUSH_FAILED: 502,
};
export const statusOf = (code: string, known: boolean) => STATUS[code] ?? (known ? 400 : 500);
const COMMIT_BODY_LIMIT = 64 * 1024 * 1024;
const bodyOf = (req: Request, limit?: number) =>
  readJson(req, limit).catch((e) => {
    throw new ApiError('INVALID_INPUT', String(e?.message ?? e));
  });

async function credentials(req: Request, env: Env): Promise<Credentials | null> {
  const bearer = req.headers.get('authorization');
  if (bearer?.startsWith('Bearer yrp_')) return { _token: bearer.slice(7) };
  const principal = await authenticate(req, env);
  if (!principal || principal.role === 'agent') return null;
  const name = principal.role === 'admin' ? 'admin' : `user:${principal.workspace}`;
  return { _session: { workspace: principal.workspace, principal: name } };
}

async function createRepository(env: Env, auth: Credentials, body: Json) {
  if (!('_session' in auth))
    throw new ApiError('FORBIDDEN', 'Repositories are created by workspace owners');
  const random = crypto.getRandomValues(new Uint8Array(10));
  const id = `r${[...random].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const store = newStore(env, `yr-${id}`);
  await store.create();
  const ctx = new RepoContext(env, id, caller(env, id, auth));
  const name = typeof body.name === 'string' && body.name ? body.name : id;
  await ctx.call({
    op: 'repo_init',
    name,
    object_store: store.spec,
    policy: body.policy ?? { required_checks: [], approvals: 1 },
  });
  // Listing projection, written after the authority accepted the repository.
  await env.INDEX.prepare(
    'INSERT INTO platform_repos(id,workspace,name,created_at) VALUES(?,?,?,?)',
  )
    .bind(id, auth._session.workspace, name, Date.now())
    .run();
  if (!Array.isArray(body.files) || body.files.length === 0) return { id };
  const seeded = await commit(ctx, new RepoObjects(env, id, store), {
    changes: body.files,
    message: body.message ?? 'Import',
    author: body.author,
  });
  const landed = await ctx.call({ op: 'repo_import', ref: 'main', commit: seeded.commit });
  return { id, commit: seeded.commit, version: landed.version };
}

function tokenSecret() {
  const raw = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  return `yrp_${raw.replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c] ?? '')}`;
}

async function route(req: Request, env: Env, url: URL, auth: Credentials): Promise<Json> {
  const parts = url.pathname.split('/').filter(Boolean).slice(2); // after api/v1
  if (parts[0] !== 'repos') throw new ApiError('NOT_FOUND', 'Unknown API path');
  if (parts.length === 1 && req.method === 'POST')
    return createRepository(env, auth, await bodyOf(req, COMMIT_BODY_LIMIT));
  if (parts.length === 1 && req.method === 'GET') {
    if (!('_session' in auth))
      throw new ApiError('FORBIDDEN', 'Repository tokens are scoped to one repository');
    const listed = await env.INDEX.prepare(
      'SELECT id,name,created_at FROM platform_repos WHERE workspace=? ORDER BY created_at DESC LIMIT 200',
    )
      .bind(auth._session.workspace)
      .all();
    return { repos: listed.results };
  }
  const repo = parts[1];
  if (!/^r[0-9a-f]{20}$/.test(repo ?? '')) throw new ApiError('NOT_FOUND', 'Unknown repository');
  const ctx = new RepoContext(env, repo, caller(env, repo, auth));
  const [resource, sha, sub] = parts.slice(2);
  const get = req.method === 'GET';
  const post = req.method === 'POST';
  const query = Object.fromEntries(url.searchParams);
  const run = (name: string, args: Json) => operations[name](ctx, args);
  if (!resource && get) return run('git_status', {});
  if (get && resource === 'refs') return run('git_refs', query);
  if (get && resource === 'log') return run('git_log', query);
  if (get && resource === 'txlog') return run('git_txlog', query);
  if (get && resource === 'merge-base') return run('git_merge_base', query);
  if (get && resource === 'tree') return run('git_ls_tree', query);
  if (get && resource === 'blob') return run('git_cat_file', query);
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
  if (resource === 'policy' && req.method === 'PUT')
    return ctx.call({ op: 'repo_set_policy', policy: (await bodyOf(req)).policy });
  if (resource === 'land' && post) return run('git_land', await bodyOf(req));
  if (resource === 'tokens' && get) return ctx.call({ op: 'repo_tokens' });
  if (resource === 'tokens' && !sha && post) {
    const body = await bodyOf(req);
    const secret = tokenSecret();
    const created = await ctx.call({
      op: 'repo_token_create',
      name: body.name,
      scopes: body.scopes,
      _secret: secret,
    });
    return { ...created, token: secret };
  }
  if (resource === 'tokens' && sha && req.method === 'DELETE')
    return ctx.call({ op: 'repo_token_revoke', name: sha });
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}

export async function repoApi(req: Request, env: Env): Promise<Response> {
  const auth = await credentials(req, env);
  if (!auth) return error('UNAUTHORIZED', 'Sign in or use a repository token', 401);
  const url = new URL(req.url);
  const mcp = /^\/api\/v1\/repos\/(r[0-9a-f]{20})\/mcp$/.exec(url.pathname);
  if (mcp) return repoMcp(req, new RepoContext(env, mcp[1], caller(env, mcp[1], auth)));
  try {
    return response(await route(req, env, url, auth));
  } catch (e: any) {
    const code = e instanceof ApiError ? e.code : (e?.code ?? 'INVALID_INPUT');
    const message = String(e?.message ?? e).slice(0, 500);
    return error(code, message, statusOf(code, e instanceof ApiError || !!e?.code));
  }
}
