// Creating a new repository's Artifacts store. Artifacts is the projected mirror: commits,
// pushes, reads and clones go through the authority, the store of record and the outboxes, so
// nothing but a projection needs the store, and one stall of Artifacts need not fail or slow
// a create. With `ASYNC_STORE=on` the create answers without it and `storeJob` makes it; off,
// `createStore` makes it in the request.
//
// Budget of a seeded create (dev, 20 creates, 2026-10-30): median 3.5 s, of which the store
// 1.9 s, slowest 3.3 s, and unbounded stalls behind it. With the job: no Artifacts call, so
// median under 2 s, slowest under 4 s, whatever Artifacts does; `create.queue` under 50 ms.
//
// With the job, what still needs the store:
// - a projection (ref, or any large file) finds it missing and ends (`storeAwaited`): the job
//   asks for a projection once the store is there.
// - a commit too large to stage (a seed too), and `POST /repos/:id/clone` for `--offline`,
//   wait for it, up to STORE_WAIT_MS, then answer a retryable 503.
// - a fork of a repository without one gets an empty store too (forkStore).
// - a mirror retirement fails its run and is tried again later, as for any Artifacts outage.
// - an import makes its own, and never meets this job: a repository nobody asked a job for.
import { bounded } from './durable';
import { STORE_PENDING } from './repo-artifacts-store';
import { caller, type Json } from './repo-ops';
import { dispatchProjection } from './repo-projection';
import { type ObjectStore, ownSpec, parseStore } from './repo-stores';
import type { Env, Envelope } from './types';

/** Each attempt of a create in the request, from the same evidence as the other bounds
 * (repo-create.ts). The last is shorter so that all of them fit under the dialog's. */
export const STORE_ATTEMPT_MS = 10_000;
const STORE_LAST_ATTEMPT_MS = 5_000;
/** The pause before the second attempt, doubled before the third. */
export const STORE_BACKOFF_MS = 1_000;

/** One attempt of the job. Nobody waits for it, so it outlasts more of a stall. */
export const STORE_JOB_ATTEMPT_MS = 30_000;
const JOB_FIRST_DELAY_SECONDS = 5;
const JOB_MAX_DELAY_SECONDS = 15 * 60;
/** About two days, then the job gives up loudly; the repository works without a mirror. */
const JOB_ATTEMPTS = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `store.create()`, where ALREADY_EXISTS is an earlier attempt having landed late: a name is
 * `yr-<new id>`. */
const landed = (store: ObjectStore, repeat: boolean) =>
  store.create().catch((e) => {
    if (!repeat || e?.code !== 'ALREADY_EXISTS') throw e;
  });

/** The store of a new repository, in the request. Whatever is left after the last attempt
 * is an outage of the store, whatever code it carries (CREATE_IN_PROGRESS on the way there is
 * a first attempt Artifacts is still working on, and the next finds it done). */
export async function createStore(store: ObjectStore) {
  const bounds = [STORE_ATTEMPT_MS, STORE_ATTEMPT_MS, STORE_LAST_ATTEMPT_MS];
  for (const [attempt, ms] of bounds.entries()) {
    try {
      return await bounded(ms, landed(store, attempt > 0));
    } catch (e) {
      if (attempt === bounds.length - 1) throw e;
    }
    await sleep(STORE_BACKOFF_MS * 2 ** attempt);
  }
}

/** Comes back as a fresh delayed message: unlike a retry that spends nothing of the queue's
 * max_retries, so a long outage leaves no store to the dead letters. */
async function again(env: Env, envelope: Envelope, cause: any) {
  const attempt = (envelope.attempt ?? 0) + 1;
  const error = String(cause?.message ?? cause).slice(0, 200);
  const failed = { event: 'store.create_failed', repo_id: envelope.repo_id, attempt, error };
  if (attempt >= JOB_ATTEMPTS) return console.error(JSON.stringify(failed));
  console.warn(JSON.stringify(failed));
  const delaySeconds = Math.min(
    JOB_FIRST_DELAY_SECONDS * 2 ** (attempt - 1),
    JOB_MAX_DELAY_SECONDS,
  );
  await env.PLATFORM_QUEUE.send({ ...envelope, attempt }, { delaySeconds });
}

/**
 * The `STORE_JOB` queue job: makes the store the authority names now. A repeat finds it made,
 * so duplicates, crashes and a first attempt landing late all end the same way. A deleted
 * repository needs none (its restore asks again), and a mirror retired since names none. A
 * store landing as its repository is deleted stays, empty and unreachable, like any late
 * create (repo-create `takeBack`).
 */
export async function storeJob(env: Env, envelope: Envelope) {
  const repo = envelope.repo_id;
  try {
    const call = caller(env, repo, { _system: 'projection' });
    const status: Json = await call({ op: 'repo_status' });
    const store = parseStore(env, ownSpec(String(status.object_store)));
    await bounded(STORE_JOB_ATTEMPT_MS, landed(store, true));
  } catch (e: any) {
    if (e?.code === 'GONE' || e?.code === 'NOT_FOUND') return;
    return again(env, envelope, e);
  }
  await dispatchProjection(env, repo);
}

/** `project`, ended quietly by a store still to come: `storeJob` asks for it again, and until
 * then the refs wait in the authority's projection outbox. */
export function storeAwaited(project: () => Promise<{ retry?: number }>) {
  return project().catch((e): { retry?: number } => {
    if (e?.code !== STORE_PENDING) throw e;
    return {};
  });
}
