// Creating platform repositories: the owner (or the operator for a named workspace) creates
// a repository, optionally seeded with files or imported from a Git remote, and may issue its
// first repository tokens in the same request.
import { afterAnswer, deferred } from './background';
import { bounded, boundedRetry, failureCode } from './durable';
import { orgArg, orgCaller, orgCommand } from './platform-orgs';
import { asyncStore, dispatchStore } from './repo-artifacts-store';
import { auditRepo } from './repo-audit';
import { commit } from './repo-commit';
import { refreshHead } from './repo-head';
import { defaultBranchSoon, startImport } from './repo-import';
import { startWorkflow } from './repo-import-start';
import { newStore, type ObjectStore, RepoObjects, toBase64 } from './repo-objects';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { requirePatScope } from './repo-pat';
import { holdName, releaseNames } from './repo-paths';
import { dispatchProjection, dispatchPurge } from './repo-projection';
import { visibilityOf } from './repo-public';
import { hintedEnv, placeCombiners, regionHint } from './repo-region-hint';
import { shardOutboxes } from './repo-shards';
import { createStore } from './repo-store-create';
import { timed } from './repo-timing';
import type { Env } from './types';

// Bounds on what a create waits for, from dev's 20 creates of 2026-10-30 (slowest: store
// 3.3 s, repo_init 0.7 s, shards 4.5 s). The dialog's own bound (CREATE_TIMEOUT_MS, 45 s) sits
// above their sum (the store's 28 s, repo-store-create; 10 s here; 5 s taking back), so a stall
// reaches people as this code's answer, not as its timeout.
const INIT_MS = 10_000;
const SHARD_START_MS = 12_000;
const TAKE_BACK_MS = 5_000;

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

function unavailable(cause: any) {
  console.warn(`repository create failed: ${cause?.message ?? cause}`);
  return new ApiError('CREATE_UNAVAILABLE', 'The repository could not be created now; try again');
}

/**
 * Starts (migrates) a new repository's commit shards ahead of its first commits, after the
 * answer: 64 cold starts cost a create 2 s at the median and 4.5 s at worst. A head start
 * only: a shard that has not started starts on its first commit, so no failure here is
 * the create's. `SHARD_START=request` waits for them instead, for comparing benches.
 */
function startShards(env: Env, id: string) {
  const start = () =>
    timed('create.shards', () => boundedRetry(SHARD_START_MS, () => shardOutboxes(env, id))).catch(
      (e) => console.warn(`commit shards did not start: ${e?.message ?? e}`),
    );
  return env.SHARD_START === 'request' ? start() : afterAnswer(start);
}

/**
 * Takes back a failed create, so that repeating it finds nothing in its way: the answer
 * waits (boundedly) for the name and the listing, and a repository the authority accepted
 * is deleted after it, tokens and objects with it. Nobody was told its id, so nothing
 * refers to it. Never throws: the failure answered is the create's own. A store or
 * authority whose create landed after its bound stays, unreachable by name or listing.
 */
async function takeBack(
  env: Env,
  ctx: RepoContext,
  owner: string,
  name: string,
  accepted: boolean,
) {
  const left = (e: any) => console.warn(`failed create left behind: ${e?.message ?? e}`);
  const repo = ctx.repo;
  await bounded(
    TAKE_BACK_MS,
    Promise.all([releaseNames(env, owner, repo), unlistRepository(env, repo)]),
  ).catch(left);
  if (!accepted) return;
  await afterAnswer(async () => {
    await ctx.call({ op: 'repo_delete', confirm: name });
    // Nobody ever saw it, so there is nothing to undo.
    await dispatchPurge(env, repo, 'now');
  }).catch(left);
}

export async function createRepository(env: Env, requester: Credentials, body: Json) {
  const hint = regionHint(env, body);
  if (!hint) return create(env, requester, body);
  const near = hintedEnv(env, hint);
  const created = await create(near, requester, body);
  await timed('create.place', () => placeCombiners(near, created.id));
  return { ...created, region_hint: hint };
}

async function create(env: Env, requester: Credentials, body: Json) {
  const auth = await timed('create.owner', () => owning(env, requester, body));
  const visibility = visibilityOf(body.visibility);
  const id = newRepoId();
  const name = typeof body.name === 'string' && body.name ? body.name : id;
  const owner = auth._session.workspace;
  await timed('create.name', () => holdName(env, owner, id, name));
  const ctx = new RepoContext(env, id, caller(env, id, auth));
  let accepted = false;
  try {
    const store = newStore(env, `yr-${id}`);
    const later = asyncStore(env);
    if (!later)
      await timed('create.store', () =>
        createStore(store).catch((e) => {
          throw unavailable(e);
        }),
      );
    await bounded(
      INIT_MS,
      ctx.call({
        op: 'repo_init',
        name,
        object_store: store.spec,
        policy: body.policy ?? { required_checks: [], approvals: 1 },
        visibility,
      }),
    );
    accepted = true;
    // Asked for before anyone can see the repository, so none is left without its store.
    if (later) await timed('create.queue', () => bounded(INIT_MS, dispatchStore(env, id)));
    const created = await populate(env, ctx, store, { name, visibility, owner }, body);
    await startShards(env, id);
    // Only now: a create that failed is taken back as if it never was.
    await auditRepo(env, id);
    return created;
  } catch (e) {
    await takeBack(env, ctx, owner, name, accepted);
    // Anything unexpected is an outage of a step, and nothing stands in the way of a retry.
    throw failureCode(e) === 'INTERNAL' ? unavailable(e) : e;
  }
}

/** All of a create after the authority accepted the repository. */
async function populate(
  env: Env,
  ctx: RepoContext,
  store: ObjectStore,
  { name, visibility, owner }: { name: string; visibility: string; owner: string },
  body: Json,
) {
  const id = ctx.repo;
  // Listing projection, written after the authority accepted the repository.
  await timed('create.list', () => listRepository(env, id, owner, name, visibility));
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
  const auth = await timed('import.owner', () => owning(env, requester, body));
  const asked_at = Date.now();
  if (env.PLATFORM_OBJECT_STORE === 'r2')
    throw new ApiError('NOT_SUPPORTED', 'Importing a remote needs the Artifacts object store');
  const fast = env.FAST_IMPORT === 'on';
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
  // Beside the writes below, so that Artifacts can be asked as soon as they end.
  const named = fast && !branch ? defaultBranchSoon(url) : Promise.resolve(null);
  await timed('import.name', () => holdName(env, owner, id, name));
  const ctx = new RepoContext(env, id, caller(env, id, auth));
  await timed('import.init', () =>
    ctx
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
      }),
  );
  const remote = await timed('import.branch', () => named);
  const params = { repo: id, url, branch: branch ?? remote ?? undefined, max, asked_at };
  // Beside the writes below: nothing of it reads them.
  if (fast) deferred(() => startImport(env, params));
  await timed('import.list', () => listRepository(env, id, owner, name, visibility));
  const tokens = await timed('import.tokens', () => issueTokens(ctx, body.tokens));
  const workflow = await timed('import.workflow', () => startWorkflow(env, params));
  await auditRepo(env, id);
  return { id, import: workflow, branch: branch ?? null, max_commits: max, ...tokens };
}

/** The listing row of a repository the authority accepted (a fork's too, or one restored,
 * which keeps its date and may be listed already by the attempt before). */
export function listRepository(
  env: Env,
  id: string,
  workspace: string,
  name: string,
  visibility: string,
  createdAt = Date.now(),
) {
  return env.INDEX.prepare(
    `INSERT INTO platform_repos(id,workspace,name,created_at,visibility) VALUES(?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,visibility=excluded.visibility`,
  )
    .bind(id, workspace, name, createdAt, visibility)
    .run();
}

/** Removes a repository's rows from the listing's projection. */
export function unlistRepository(env: Env, repo: string) {
  return env.INDEX.batch([
    env.INDEX.prepare('DELETE FROM platform_repos WHERE id=?').bind(repo),
    env.INDEX.prepare('DELETE FROM platform_members WHERE repo=?').bind(repo),
    env.INDEX.prepare('DELETE FROM platform_activity WHERE repo=?').bind(repo),
  ]);
}

export function tokenSecret() {
  const raw = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  return `yrp_${raw.replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c] ?? '')}`;
}
