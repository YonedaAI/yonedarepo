// Creating platform repositories: the owner (or the operator for a named workspace) creates
// a repository, optionally seeded with files or imported from a Git remote, and may issue its
// first repository tokens in the same request.
import { commit } from './repo-commit';
import { newStore, RepoObjects, toBase64 } from './repo-objects';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { refreshHead } from './repo-head';
import { dispatchProjection } from './repo-projection';
import { shardOutboxes } from './repo-shards';
import type { Env } from './types';

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

export async function createRepository(env: Env, requester: Credentials, body: Json) {
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
  // Commit shards start (migrate) now rather than on the first commits' path.
  await shardOutboxes(env, id);
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
  // Main's head is published (and its holder started) before the first commits need it.
  await Promise.all([dispatchProjection(env, id), refreshHead(env, id)]);
  return { id, commit: seeded.commit, tree: seeded.tree, version: landed.version, ...tokens };
}

/** Starts a durable import of an external Git repository (Artifacts-backed only). */
export async function importRepository(env: Env, requester: Credentials, body: Json) {
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

export function tokenSecret() {
  const raw = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  return `yrp_${raw.replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c] ?? '')}`;
}
