// Creating platform repositories: the owner (or the operator for a named workspace) creates
// a repository, optionally seeded with files or imported from a Git remote, and may issue its
// first repository tokens in the same request.
import { orgArg, orgCaller, orgCommand } from './platform-orgs';
import { commit } from './repo-commit';
import { refreshHead } from './repo-head';
import { newStore, RepoObjects, toBase64 } from './repo-objects';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { requirePatScope } from './repo-pat';
import { holdName, releaseNames } from './repo-paths';
import { dispatchProjection } from './repo-projection';
import { visibilityOf } from './repo-public';
import { shardOutboxes } from './repo-shards';
import { timed } from './repo-timing';
import type { Env } from './types';

/**
 * Who owns a new repository: the signed-in workspace, its personal token with repo:admin
 * (acting as the account, never as a person), an organization (`owner`) one of whose
 * owners asks, or, for the operator (admin bearer) provisioning on someone's behalf, the
 * named `workspace`. Never a repository token. Only org owners create an org's
 * repositories (asked of the org's authority at once, never from a cached answer); members
 * get access through teams or membership afterwards.
 */
export async function owning(
  env: Env,
  auth: Credentials,
  body: Json,
): Promise<Credentials & { _session: Json }> {
  if (body.owner !== undefined && body.owner !== null) {
    if (body.workspace !== undefined)
      throw new ApiError('INVALID_INPUT', 'Name an owner or a workspace, not both');
    const org = orgArg(body.owner);
    if ('_pat' in auth) requirePatScope(auth, 'repo:admin');
    const { account } = orgCaller(auth, true, org);
    const access = await orgCommand(env, org, { op: 'org_access', account });
    if (access.role !== 'owner')
      throw new ApiError('FORBIDDEN', `Only an owner of ${org} creates its repositories`);
    return { _session: { workspace: org, principal: `user:${account}` } };
  }
  if ('_pat' in auth && auth._pat.org)
    throw new ApiError(
      'FORBIDDEN',
      `This token is limited to the ${auth._pat.org} organization; name it as the owner`,
    );
  if ('_pat' in auth) {
    requirePatScope(auth, 'repo:admin');
    if (body.workspace !== undefined)
      throw new ApiError(
        'FORBIDDEN',
        'Only the operator creates repositories for another workspace',
      );
    return { _session: { workspace: auth._pat.workspace, principal: auth._pat.principal } };
  }
  if ('_anonymous' in auth) throw new ApiError('UNAUTHORIZED', 'Sign in to create repositories');
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

/** A new repository id: `r` and 20 hex digits. */
export function newRepoId() {
  const random = crypto.getRandomValues(new Uint8Array(10));
  return `r${[...random].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function createRepository(env: Env, requester: Credentials, body: Json) {
  const auth = await timed('create.owner', () => owning(env, requester, body));
  const visibility = visibilityOf(body.visibility);
  const id = newRepoId();
  const name = typeof body.name === 'string' && body.name ? body.name : id;
  const owner = auth._session.workspace;
  await timed('create.name', () => holdName(env, owner, id, name));
  const ctx = new RepoContext(env, id, caller(env, id, auth));
  let store: ReturnType<typeof newStore>;
  try {
    store = newStore(env, `yr-${id}`);
    await timed('create.store', () => store.create());
    await ctx.call({
      op: 'repo_init',
      name,
      object_store: store.spec,
      policy: body.policy ?? { required_checks: [], approvals: 1 },
      visibility,
    });
  } catch (e) {
    await releaseNames(env, owner, id).catch(() => {});
    throw e;
  }
  // Commit shards start (migrate) now rather than on the first commits' path.
  await timed('create.shards', () => shardOutboxes(env, id));
  // Listing projection, written after the authority accepted the repository.
  await timed('create.list', () =>
    listRepository(env, id, auth._session.workspace, name, visibility),
  );
  const tokens = await timed('create.tokens', () => issueTokens(ctx, body.tokens));
  if (!Array.isArray(body.files) || body.files.length === 0) return { id, ...tokens };
  const seeded = await timed('create.commit', () =>
    commit(ctx, new RepoObjects(env, id, store), {
      changes: body.files,
      message: body.message ?? 'Import',
      author: body.author,
    }),
  );
  const landed = await ctx.call({ op: 'repo_import', ref: 'main', commit: seeded.commit });
  // Main's head is published (and its holder started) before the first commits need it.
  await Promise.all([
    timed('create.project', () => dispatchProjection(env, id)),
    timed('create.head', () => refreshHead(env, id)),
  ]);
  return { id, commit: seeded.commit, tree: seeded.tree, version: landed.version, ...tokens };
}

/** Starts a durable import of an external Git repository (Artifacts-backed only). */
export async function importRepository(env: Env, requester: Credentials, body: Json) {
  const auth = await owning(env, requester, body);
  if (env.PLATFORM_OBJECT_STORE === 'r2')
    throw new ApiError('NOT_SUPPORTED', 'Importing a remote needs the Artifacts object store');
  const visibility = visibilityOf(body.visibility);
  const url = String(body.url ?? '');
  if (!/^https:\/\/[^\s]+$/.test(url))
    throw new ApiError('INVALID_INPUT', 'url must be an HTTPS Git remote');
  // None named: the remote's default branch (its HEAD), whatever it is called.
  const branch = typeof body.branch === 'string' && body.branch ? body.branch : undefined;
  const max = Math.min(Math.max(Number(body.max_commits ?? 100) || 100, 1), 5000);
  const id = newRepoId();
  const name = typeof body.name === 'string' && body.name ? body.name : id;
  const owner = auth._session.workspace;
  await holdName(env, owner, id, name);
  const ctx = new RepoContext(env, id, caller(env, id, auth));
  await ctx
    .call({
      op: 'repo_init',
      name,
      // Artifacts creates the store itself during import.
      object_store: `artifacts:${env.ARTIFACTS_NAMESPACE}/yr-${id}`,
      policy: body.policy ?? { required_checks: [], approvals: 1 },
      visibility,
    })
    .catch(async (e) => {
      await releaseNames(env, owner, id).catch(() => {});
      throw e;
    });
  await listRepository(env, id, auth._session.workspace, name, visibility);
  const tokens = await issueTokens(ctx, body.tokens);
  const instance = await env.PLATFORM_IMPORT.create({
    id: `import-${id}`,
    params: { repo: id, url, branch, max },
  });
  return { id, import: instance.id, branch: branch ?? null, max_commits: max, ...tokens };
}

/** The listing row of a repository the authority accepted (a fork's too). */
export function listRepository(
  env: Env,
  id: string,
  workspace: string,
  name: string,
  visibility: string,
) {
  return env.INDEX.prepare(
    'INSERT INTO platform_repos(id,workspace,name,created_at,visibility) VALUES(?,?,?,?,?)',
  )
    .bind(id, workspace, name, Date.now(), visibility)
    .run();
}

export function tokenSecret() {
  const raw = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  return `yrp_${raw.replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c] ?? '')}`;
}
