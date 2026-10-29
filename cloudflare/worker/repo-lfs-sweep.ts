// The sweep of LFS bytes no object references (a reservation that lapsed, an upload that
// failed verification). The authority decides (repo_store/lfs/sweep.rs): it queues such
// bytes as orphans, leases them to this job and fences a late finisher, so the bytes
// deleted here are never an object's. The job claims, deletes the claimed keys from R2 and
// reports, then schedules itself for when the authority says work is next due. A batch or
// verify that arms the sweep (`sweep_at`) schedules it the same way. Deleting is idempotent
// and a lost report only lets the lease run out, so redelivery is safe.
import { failureCode } from './durable';
import { caller } from './repo-ops';
import type { Env, Envelope } from './types';

/** An LFS object's R2 key, under its repository's prefix (so a purge removes it too). */
export const lfsKey = (repo: string, oid: string) => `platform/v1/${repo}/lfs/${oid}`;

/** Orphans one claim takes (one R2 delete call takes at most 1000 keys). */
const CLAIM = 1000;
/** Claims one job works through before it hands on to its next run. */
const ROUNDS = 10;
/** Keys are deleted only with this much of the lease left, so no delete outlives it. */
const MARGIN_MS = 60_000;
/** The longest delay a queue message takes; a later due time is reached in steps. */
const MAX_DELAY_SECONDS = 12 * 60 * 60;

/** Schedules the sweep of `repo` for `at` (ms; null or undefined: nothing to schedule). */
export async function scheduleSweep(env: Env, repo: string, at: unknown) {
  if (typeof at !== 'number') return;
  const delaySeconds = Math.min(
    Math.max(Math.ceil((at - Date.now()) / 1000), 0),
    MAX_DELAY_SECONDS,
  );
  const envelope: Envelope = {
    v: 1,
    kind: 'platform_lfs_sweep',
    repo_id: repo,
    job_id: `lfs-sweep-${at}`,
  };
  await env.PLATFORM_QUEUE.send(envelope, delaySeconds > 0 ? { delaySeconds } : undefined);
}

/** Sweeps `repo`'s orphans now; answers when the sweep is next due (null: nothing waits). */
export async function sweepLfs(env: Env, repo: string): Promise<number | null> {
  const call = caller(env, repo, { _system: 'lfs' });
  for (let round = 0; round < ROUNDS; round++) {
    const claimed = await call({ op: 'repo_lfs_sweep_claim', limit: CLAIM });
    const claims = claimed.claims as { oid: string; epoch: number }[];
    if (claims.length === 0) return claimed.next_at ?? null;
    // Too little lease left (a slow claim): let it run out; the next run claims again.
    if (claimed.lease_until - Date.now() < MARGIN_MS) return claimed.lease_until;
    await env.OBJECTS.delete(claims.map(({ oid }) => lfsKey(repo, oid)));
    await call({ op: 'repo_lfs_sweep_done', claims });
    if (claims.length < CLAIM) return claimed.next_at ?? null;
  }
  return Date.now();
}

/** The queue job: one sweep, then the next one scheduled. A deleted repository's purge
 * removes its bytes, so its sweep ends quietly. */
export async function lfsSweepJob(env: Env, envelope: Envelope) {
  try {
    await scheduleSweep(env, envelope.repo_id, await sweepLfs(env, envelope.repo_id));
  } catch (e) {
    if (!['GONE', 'NOT_FOUND'].includes(failureCode(e))) throw e;
  }
}
