// Erasing a deleted repository (`REPO_ERASE=on`; repo_store/erase.rs has the authority's
// half). Deletion leaves a tombstone and the purge job its object store; this job, sent by
// the end of a purge however long after the deletion that runs, empties what is left: every
// commit shard, the combiners, and in small transactions the authority's own records. The
// tombstone stays, answering GONE. Each part is repeatable and the authority's rows go last,
// because they name the combiners to clear, so a job that dies anywhere is simply run again.
// Logs carry counts and ids, never content.
//
// Other per-repository objects hold nothing to erase: PackBuilder's storage is its
// container's lifecycle state, CheckContainer's the same, and ObjectPushQueue keeps none.

import { durableJson } from './durable';
import { log } from './log';
import { audit } from './platform-admin-queries';
import { currentHold } from './platform-legal-hold';
import { dispatchErase, eraseOn, purgeObjects } from './repo-admin';
import { inBatches } from './repo-git-objects';
import { dispatchHooks } from './repo-hooks';
import { ApiError, caller, type Json } from './repo-ops';
import { dispatchPurge } from './repo-projection';
import { SHARDS, shardCall } from './repo-shards';
import { ownSpec } from './repo-stores';
import type { Env, Envelope } from './types';

/** Steps per job: each is a Durable Object round trip, and a long erase continues in a
 * fresh job, so one repository never holds a consumer for long. */
const STEPS_PER_JOB = 100;
/** Seconds between looks while hooks are delivered (each look sends their jobs again, as
 * one that ran out of queue retries is otherwise never replaced). */
const HOOK_WAIT_SECONDS = 300;
/** Objects cleared at once (an invocation keeps six connections open). */
const WIDTH = 6;

function progress(repo: string, phase: string, details: Json = {}) {
  log.info('repo.erase', { repo, phase, ...details });
}

type Erasable = { erase(): Promise<void> };

/** Every commit shard and combiner of `repo`. A combiner is named by its ref as the caller
 * spelled it, so each ref is cleared both ways. */
async function clearObjects(env: Env, repo: string, refs: string[]) {
  const shards = Array.from({ length: SHARDS }, (_, shard) => shard);
  const _hold = await currentHold(env, repo, caller(env, repo, { _system: 'purge' }));
  if (env.COMMIT_SHARDS)
    await inBatches(shards, WIDTH, (shard) =>
      shardCall(env, repo, shard, { op: 'store_erase', _hold }),
    );
  const combiners = env.LAND_COMBINERS;
  if (!combiners) return;
  const names = new Set([`${repo}#head`, `${repo}#projector`]);
  for (const ref of refs) {
    names.add(`${repo}:${ref}`);
    names.add(`${repo}:${ref.replace(/^refs\/heads\//, '')}`);
  }
  await inBatches([...names], WIDTH, (name) =>
    (combiners.get(combiners.idFromName(name)) as unknown as Erasable).erase(),
  );
}

/** The `platform_erase` queue job (see the module comment). */
export async function eraseJob(env: Env, envelope: Envelope) {
  if (!eraseOn(env)) return;
  const repo = envelope.repo_id;
  const call = caller(env, repo, { _system: 'erase' });
  if (envelope.job_id !== 'records') {
    const plan: Json = await call({ op: 'repo_erase_plan' }).catch((e) => {
      // Never initialized: a create that failed before its first command.
      if (e instanceof ApiError && e.code === 'NOT_FOUND') return { live: true };
      throw e;
    });
    // Still in its undo window (a job sent early): the end of its purge starts the erase.
    if (plan.live || plan.erased || plan.not_due) return;
    if (plan.forks) return progress(repo, 'blocked', { forks: plan.forks });
    if (plan.hooks) {
      await Promise.all(
        (plan.hooks as number[]).map((id) => dispatchHooks(env, repo, `hook:${id}`)),
      );
      await dispatchErase(env, repo, 'start', HOOK_WAIT_SECONDS);
      return progress(repo, 'hooks', { hooks: plan.hooks.length });
    }
    await clearObjects(env, repo, plan.refs);
    // A shard's drain that raced the purge put objects back; with the shards empty, none can.
    await purgeObjects(env, repo);
    progress(repo, 'objects', { db_bytes: plan.db_bytes });
  }
  let rows = 0;
  for (let step = 0; step < STEPS_PER_JOB; step++) {
    const done: Json = await call({ op: 'repo_erase_step' });
    rows += done.rows;
    if (done.done) return progress(repo, 'erased', { rows, db_bytes: done.db_bytes });
  }
  await dispatchErase(env, repo, 'records');
  progress(repo, 'records', { rows });
}

/** The repository a tombstone's object store names, confirmed against its object's id:
 * nothing else in the object says which repository it was. */
function repoOf(env: Env, object: string, store: string) {
  const repo = /r[0-9a-f]{20}/.exec(ownSpec(store))?.[0];
  return repo && env.SOURCE_REPOS.idFromName(repo).toString() === object ? repo : null;
}

/**
 * `POST admin/erase-backfill {object, dry_run}`: one repository object, by its id (Cloudflare
 * lists ids, and only a repository's own store still names it once D1 forgot it). Reports its
 * `state`: `empty`, `live`, `erased`, `blocked` (a fork is left), `unnamed` (its store does
 * not lead back to this id), or `tombstone`, which unless `dry_run` queues the purge, whose
 * end starts the erase: the first purge may have died, and the erase must follow one.
 */
export async function backfillObject(env: Env, actor: string, body: Json) {
  const object = String(body.object ?? '');
  if (!/^[0-9a-f]{64}$/.test(object))
    throw new ApiError('INVALID_INPUT', 'object must be a Durable Object id');
  const dryRun = body.dry_run === true;
  if (!dryRun && !eraseOn(env)) throw new ApiError('CONFLICT', 'REPO_ERASE is off');
  const id = env.SOURCE_REPOS.idFromString(object);
  const plan = await durableJson<Json>(
    () => env.SOURCE_REPOS.get(id),
    'https://source-repository/',
    JSON.stringify({ op: 'repo_erase_plan', _system: 'erase' }),
  );
  if (plan.error) {
    if (plan.error.code === 'NOT_FOUND') return { state: 'empty' };
    throw new ApiError(plan.error.code, plan.error.message);
  }
  const { db_bytes } = plan;
  if (plan.live) return { state: 'live', db_bytes };
  if (plan.erased) return { state: 'erased', db_bytes };
  if (plan.forks) return { state: 'blocked', db_bytes, forks: plan.forks };
  const repo = repoOf(env, object, String(plan.object_store));
  if (!repo) return { state: 'unnamed', db_bytes };
  const found = { repo, db_bytes, waiting: Boolean(plan.hooks) };
  if (dryRun) return { state: 'tombstone', ...found };
  await dispatchPurge(env, repo);
  await audit(env, actor, 'repo.erase_backfill', repo, { db_bytes });
  return { state: 'queued', ...found };
}
