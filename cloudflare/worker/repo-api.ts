// Public API of the YonedaRepo source platform (`/api/v1`). A thin adapter: it
// authenticates, maps routes onto the shared operation table, and forwards commands to
// the repository's SourceRepository Durable Object, which owns every decision. Callers
// are workspace sessions (owners) or repository tokens (agents, CI, scripts) — all the
// same to us.
import { authenticate } from './auth';
import { error, readJson, response } from './http';
import { breakGlass } from './repo-break-glass';
import { repoMcp } from './repo-mcp';
import { newStore, parseStore, RepoObjects, toBase64 } from './repo-objects';
import { ApiError, type Credentials, caller, commit, type Json, RepoContext } from './repo-ops';
import { dispatchProjection } from './repo-projection';
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
  // Only a personal account session is a person; admin bearers may be held by scripts.
  const human = principal.role === 'user' ? { human: true as const } : {};
  return { _session: { workspace: principal.workspace, principal: name, ...human } };
}

/**
 * Who owns a new repository: the signed-in workspace, or, for the operator (admin bearer)
 * provisioning on someone's behalf, the named `workspace`. Never a repository token.
 */
function owning(auth: Credentials, body: Json): Credentials & { _session: Json } {
  if (!('_session' in auth))
    throw new ApiError('FORBIDDEN', 'Repositories are created by workspace owners');
  if (body.workspace === undefined) return auth;
  if (auth._session.principal !== 'admin')
    throw new ApiError('FORBIDDEN', 'Only the operator creates repositories for another workspace');
  if (typeof body.workspace !== 'string' || !/^[a-z0-9._+@-]{1,254}$/.test(body.workspace))
    throw new ApiError('INVALID_INPUT', 'workspace must be an account identifier');
  return { _session: { workspace: body.workspace, principal: 'admin' } };
}

/** Repository tokens issued with the repository, by its owner, in the same request. */
async function issueTokens(ctx: RepoContext, requested: unknown) {
  if (requested === undefined) return {};
  if (!Array.isArray(requested) || requested.length > 4)
    throw new ApiError('INVALID_INPUT', 'tokens must be a list of at most 4 {name, scopes}');
  const tokens: Json[] = [];
  for (const spec of requested as Json[]) {
    const secret = tokenSecret();
    const created = await ctx.call({
      op: 'repo_token_create',
      name: spec?.name,
      scopes: spec?.scopes,
      paths: spec?.paths ?? null,
      _secret: secret,
    });
    tokens.push({ ...created, token: secret });
  }
  return { tokens };
}

async function createRepository(env: Env, requester: Credentials, body: Json) {
  const auth = owning(requester, body);
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
  const tokens = await issueTokens(ctx, body.tokens);
  if (!Array.isArray(body.files) || body.files.length === 0) return { id, ...tokens };
  const seeded = await commit(ctx, new RepoObjects(env, id, store), {
    changes: body.files,
    message: body.message ?? 'Import',
    author: body.author,
  });
  const landed = await ctx.call({ op: 'repo_import', ref: 'main', commit: seeded.commit });
  await dispatchProjection(env, id);
  return { id, commit: seeded.commit, tree: seeded.tree, version: landed.version, ...tokens };
}

/** Starts a durable import of an external Git repository (Artifacts-backed only). */
async function importRepository(env: Env, requester: Credentials, body: Json) {
  const auth = owning(requester, body);
  if (env.PLATFORM_OBJECT_STORE === 'r2')
    throw new ApiError('NOT_SUPPORTED', 'Importing a remote needs the Artifacts object store');
  const url = String(body.url ?? '');
  if (!/^https:\/\/[^\s]+$/.test(url))
    throw new ApiError('INVALID_INPUT', 'url must be an HTTPS Git remote');
  const branch = typeof body.branch === 'string' && body.branch ? body.branch : 'main';
  const max = Math.min(Math.max(Number(body.max_commits ?? 100) || 100, 1), 5000);
  const random = crypto.getRandomValues(new Uint8Array(10));
  const id = `r${[...random].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const name = typeof body.name === 'string' && body.name ? body.name : id;
  const ctx = new RepoContext(env, id, caller(env, id, auth));
  await ctx.call({
    op: 'repo_init',
    name,
    // Artifacts creates the store itself during import.
    object_store: `artifacts:${env.ARTIFACTS_NAMESPACE}/yr-${id}`,
    policy: body.policy ?? { required_checks: [], approvals: 1 },
  });
  await env.INDEX.prepare(
    'INSERT INTO platform_repos(id,workspace,name,created_at) VALUES(?,?,?,?)',
  )
    .bind(id, auth._session.workspace, name, Date.now())
    .run();
  const tokens = await issueTokens(ctx, body.tokens);
  const instance = await env.PLATFORM_IMPORT.create({
    id: `import-${id}`,
    params: { repo: id, url, branch, max },
  });
  return { id, import: instance.id, branch, max_commits: max, ...tokens };
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
  if (parts.length === 2 && parts[1] === 'import' && req.method === 'POST')
    return importRepository(env, auth, await bodyOf(req));
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
  if (resource === 'policy' && req.method === 'PUT')
    return ctx.call({ op: 'repo_set_policy', policy: (await bodyOf(req)).policy });
  if (resource === 'objects' && post)
    return run('git_get_objects', await bodyOf(req, 2 * 1024 * 1024));
  if (resource === 'merges' && post) return run('git_merge', await bodyOf(req));
  if (resource === 'land' && post) return run('git_land', await bodyOf(req));
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
    const created = await ctx.call({
      op: 'repo_token_create',
      name: body.name,
      scopes: body.scopes,
      paths: body.paths ?? null,
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
  // MCP is the agent surface: it never carries a human marker, so break-glass (which is not
  // an MCP tool either) stays unreachable through it.
  const machine: Credentials =
    '_session' in auth
      ? { _session: { workspace: auth._session.workspace, principal: auth._session.principal } }
      : auth;
  if (mcp) return repoMcp(req, new RepoContext(env, mcp[1], caller(env, mcp[1], machine)));
  try {
    return response(await route(req, env, url, auth));
  } catch (e: any) {
    const code = e instanceof ApiError ? e.code : (e?.code ?? 'INVALID_INPUT');
    const message = String(e?.message ?? e).slice(0, 500);
    const status = statusOf(code, e instanceof ApiError || !!e?.code);
    if (e instanceof ApiError && e.details)
      return response({ error: { code, message, details: e.details } }, status);
    return error(code, message, status);
  }
}
