// Writes what the authority staged into the store of record: staged commits (accepted once
// the authority held their objects) go to R2, and the staged copies are dropped.

import { parseStore, RepoObjects } from './repo-objects';
import { caller, type Json } from './repo-ops';
import { shardCall } from './repo-shards';
import { putRaw } from './repo-stores';
import { carriedQueue } from './request-scope';
import type { Env, Envelope } from './types';

const dispatch = (env: Env, job: Omit<Envelope, 'v'>) =>
  carriedQueue(env.PLATFORM_QUEUE).send({ v: 1, ...job });

/** Asks for a deleted repository's object store and platform objects to be purged, now if
 * its window allows (`purge`), or whatever the window says (`now`: no window applies). Never
 * sent for later: see repo-deleted.ts. */
export async function dispatchPurge(env: Env, repo: string, job: 'purge' | 'now' = 'purge') {
  await dispatch(env, { kind: 'platform_purge', repo_id: repo, job_id: `${job}-${repo}` });
}

/** Asks for a drain of the authority's object outbox, or of commit shard `shard`'s. */
export async function dispatchObjects(env: Env, repo: string, shard?: number) {
  const job_id = shard === undefined ? 'objects' : `shard:${shard}`;
  await dispatch(env, { kind: 'platform_objects', repo_id: repo, job_id });
}

// Rounds of up to 64 commits per invocation: each object write is a subrequest, and a
// Worker invocation has a bounded number.
const OUTBOX_ROUNDS = 2;

/** Writes one staged commit's objects to the store of record; each write is confirmed. */
async function projectCommit(objects: RepoObjects, entry: Json) {
  try {
    await putRaw(objects.env, (id) => objects.rawKey(id), entry.objects);
    return { commit: entry.commit, outcome: 'ok' };
  } catch (e: any) {
    const detail = `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e).slice(0, 300)}`;
    return { commit: entry.commit, outcome: 'failed', detail };
  }
}

/**
 * Drains the object outbox into R2, and the authority drops its staged copies only for
 * commits whose every object write was confirmed. Idempotent under duplicate delivery;
 * throws (for queue retry) while a commit fails, and hands a long outbox to a fresh job.
 */
export async function projectObjects(env: Env, repo: string, job = 'objects') {
  const shard = /^shard:(\d+)$/.exec(job);
  const authority = caller(env, repo, { _system: 'projection' });
  const call = shard
    ? (c: Json) =>
        shardCall(env, repo, Number(shard[1]), { ...c, op: c.op.replace(/^repo_/, 'store_') })
    : authority;
  let objects: RepoObjects | undefined;
  let projected = 0;
  for (let round = 0; round < OUTBOX_ROUNDS; round++) {
    const { commits } = await call({ op: 'repo_objects_pending' });
    if (commits.length === 0) return { projected, more: false };
    if (!objects) {
      const status = await authority({ op: 'repo_status' });
      objects = new RepoObjects(env, repo, parseStore(env, status.object_store));
    }
    const store = objects;
    const results = await Promise.all((commits as Json[]).map((e) => projectCommit(store, e)));
    await call({ op: 'repo_objects_projected', results });
    const failed = results.filter((r) => r.outcome !== 'ok');
    if (failed.length > 0) throw new Error(`${failed.length} staged commits are not in R2 yet`);
    projected += results.length;
  }
  await dispatchObjects(env, repo, shard ? Number(shard[1]) : undefined);
  return { projected, more: true };
}
