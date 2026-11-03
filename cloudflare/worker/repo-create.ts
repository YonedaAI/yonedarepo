// Creating platform repositories: the owner (or the operator for a named workspace) creates
// a repository, optionally seeded with files or imported from a Git remote, and may issue its
// first repository tokens in the same request. Access admission lives in repo-create-access;
// network import executes in repo-clone, and compensation is shared with forks.

import { noteOwnerCell } from './account-place';
import { afterAnswer } from './background';
import { cellForNew } from './cell-choice';
import { askCell } from './cell-route';
import { cellsOn, newRepoId, thisCell } from './cells';
import { bounded, boundedRetry, failureCode } from './durable';
import { log } from './log';
import { importSource } from './platform-github-import';
import { auditRepo, auditRepoForget } from './repo-audit';
import { commit } from './repo-commit';
import { issueTokens, owning } from './repo-create-access';

export { owning, tokenSecret } from './repo-create-access';

import { refreshHead } from './repo-head';
import { startWorkflow } from './repo-import-start';
import { localityRegion } from './repo-locality';
import { type ObjectStore, RepoObjects } from './repo-objects';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { holdName, releaseNames } from './repo-paths';
import { PlatformStore } from './repo-platform-store';
import { dispatchPurge } from './repo-projection';
import { visibilityOf } from './repo-public';
import { hintedEnv, placeCombiners, regionHint } from './repo-region-hint';
import { shardOutboxes } from './repo-shards';
import { timed } from './repo-timing';
import type { Env } from './types';

// Bounds on what a create waits for, from dev's 20 creates of 2026-10-30 (slowest: repo_init
// 0.7 s, shards 4.5 s). The dialog's own bound (CREATE_TIMEOUT_MS, 45 s) sits above their sum,
// so a stall reaches people as this code's answer, not as its timeout.
const INIT_MS = 10_000;
const SHARD_START_MS = 12_000;
const TAKE_BACK_MS = 5_000;

function unavailable(cause: any) {
  log.warn('repo.create_failed', { error: cause });
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
      (e) => log.warn('shard.start_failed', { error: e }),
    );
  return env.SHARD_START === 'request' ? start() : afterAnswer(start);
}

/**
 * Takes back a failed create or fork, so that repeating it finds nothing in its way: the answer
 * waits (boundedly) for the name and the listing, and a repository the authority accepted
 * is deleted after it, tokens and objects with it. Nobody was told its id, so there is
 * nothing to undo or log. Never throws: the failure answered is the create's own. A store or
 * authority whose create landed after its bound stays, unreachable by name or listing.
 */
export async function takeBack(
  env: Env,
  ctx: RepoContext,
  owner: string,
  name: string,
  accepted: boolean,
  parent?: string,
) {
  const left = (e: any) => log.warn('repo.create_left_behind', { error: e });
  const repo = ctx.repo;
  await bounded(
    TAKE_BACK_MS,
    Promise.all([
      releaseNames(env, owner, repo),
      unlistRepository(env, repo),
      ...(parent
        ? [caller(env, parent, { _system: 'fork' })({ op: 'repo_fork_forget', fork: repo })]
        : []),
    ]),
  ).catch(left);
  if (!accepted) return;
  await afterAnswer(async () => {
    await ctx.call({ op: 'repo_delete', confirm: name });
    await auditRepoForget(env, repo);
    await dispatchPurge(env, repo, 'now');
  }).catch(left);
}

export async function createRepository(env: Env, requester: Credentials, body: Json) {
  const cell = await cellForNew(env, body);
  if (cell !== thisCell(env))
    return askCell(env, cell, '/api/v1/repos', {
      method: 'POST',
      body: JSON.stringify({ ...body, region: cell }),
    });
  const local = localityRegion(env);
  const hint = regionHint(env, body) ?? (local && cellsOn(env) ? cell : local);
  if (!hint) {
    const created = await create(env, requester, body);
    return cellsOn(env) ? { ...created, region: cell } : created;
  }
  const near = hintedEnv(env, hint);
  const created = await create(near, requester, body);
  await timed('create.place', () => placeCombiners(near, created.id));
  return { ...created, region_hint: hint };
}

async function create(env: Env, requester: Credentials, body: Json) {
  const auth = await timed('create.owner', () => owning(env, requester, body));
  const visibility = visibilityOf(body.visibility);
  const id = newRepoId(env);
  const name = typeof body.name === 'string' && body.name ? body.name : id;
  const owner = auth._session.workspace;
  await timed('create.name', () => holdName(env, owner, id, name));
  const ctx = new RepoContext(env, id, caller(env, id, auth));
  let accepted = false;
  try {
    const store = new PlatformStore(env, id);
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
    const created = await populate(env, ctx, store, { name, visibility, owner }, body);
    await startShards(env, id);
    await noteOwnerCell(env, owner);
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
  await timed('create.head', () => refreshHead(env, id));
  return { id, commit: seeded.commit, tree: seeded.tree, version: landed.version, ...tokens };
}

/** Starts a durable import of a public Git repository (`cloneRepository`). */
export async function importRepository(env: Env, requester: Credentials, body: Json) {
  const cell = await cellForNew(env, body);
  if (cell !== thisCell(env))
    return askCell(env, cell, '/api/v1/repos/import', {
      method: 'POST',
      body: JSON.stringify({ ...body, region: cell }),
    });
  const hint = localityRegion(env);
  if (hint) env = hintedEnv(env, hint);
  const auth = await timed('import.owner', () => owning(env, requester, body));
  const asked_at = Date.now();
  const { url, github, hidden } = await timed('import.source', () =>
    importSource(env, requester, body),
  );
  // A private source stays private, whatever was asked.
  const visibility = hidden ? 'private' : visibilityOf(body.visibility);
  // None named: the remote's default branch lands as main.
  const branch = typeof body.branch === 'string' && body.branch ? body.branch : undefined;
  const id = newRepoId(env);
  const name = typeof body.name === 'string' && body.name ? body.name : id;
  const owner = auth._session.workspace;
  await timed('import.name', () => holdName(env, owner, id, name));
  const ctx = new RepoContext(env, id, caller(env, id, auth));
  await timed('import.init', () =>
    ctx
      .call({
        op: 'repo_init',
        name,
        object_store: new PlatformStore(env, id).spec,
        policy: body.policy ?? { required_checks: [], approvals: 1 },
        visibility,
      })
      .catch(async (e) => {
        await releaseNames(env, owner, id).catch(() => {});
        throw e;
      }),
  );
  if (hint) {
    await shardOutboxes(env, id);
    await placeCombiners(env, id);
  }
  await timed('import.list', () => listRepository(env, id, owner, name, visibility));
  await noteOwnerCell(env, owner);
  const tokens = await timed('import.tokens', () => issueTokens(ctx, body.tokens));
  const workflow = await timed('import.workflow', () =>
    startWorkflow(env, { repo: id, url, branch, asked_at, ...(github && { github }) }),
  );
  await auditRepo(env, id);
  return { id, import: workflow, branch: branch ?? null, ...tokens };
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
