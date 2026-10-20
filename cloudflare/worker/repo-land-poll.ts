// Draining a branch's landing queue without a combiner: the waiting landers themselves
// land changesets (changeset mode) and build merge batches when the lease is free, backing
// off while another lander holds it.
import { type LandMode, landChangesets } from './repo-changesets';
import { landBatch, type Settled } from './repo-merge';
import { ApiError, type Json, type RepoContext } from './repo-ops';

const WAIT_FIRST_MS = 20;
const WAIT_MAX_MS = 320;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The merge path's claim: in changeset mode only the items left for merges. */
export const claimCommand = (ref: string, mode: LandMode, ticket?: number) => ({
  op: 'repo_land_claim',
  ref,
  ...(ticket === undefined ? {} : { ticket }),
  ...(mode === 'changeset' ? { slow_only: true } : {}),
});

/** Polls the queue with back-off until `ticket` settles; returns its status. */
export async function pollLanding(
  merger: RepoContext,
  ref: string,
  ticket: number,
  deadline: number,
  mode: LandMode,
): Promise<Json> {
  // Waiters back off: a hundred waiters polling every few milliseconds would starve the
  // commits and the merger they wait for.
  let pause = WAIT_FIRST_MS;
  const wait = async () => {
    await sleep(pause / 2 + Math.random() * pause);
    pause = Math.min(pause * 2, WAIT_MAX_MS);
  };
  const mine = (settled: Settled[]) => settled.find((s) => s.ticket === ticket);
  while (Date.now() < deadline) {
    if (mode === 'changeset') {
      const step = await landChangesets(merger, ref);
      const done = mine(step.settled as Settled[]);
      if (done) return done;
      if (step.wait !== undefined) {
        await wait();
        continue;
      }
      if (step.more) continue;
    }
    // The claim answers for this ticket once it is settled: one authority call per poll.
    const claim = await merger.call(claimCommand(ref, mode, ticket));
    if (claim.settled) return claim.settled;
    if (claim.wait) {
      await wait();
      continue;
    }
    if (claim.empty || !claim.items?.length) {
      if (!claim.empty) await merger.call({ op: 'repo_land_release', ref, epoch: claim.epoch });
      continue;
    }
    try {
      const done = mine(await landBatch(merger, claim));
      if (done) return done;
    } catch (e: any) {
      await merger.call({ op: 'repo_land_release', ref, epoch: claim.epoch }).catch(() => {});
      // Lost the compare-and-swap (the branch moved while the batch was built): rebuild.
      if (e?.code !== 'STALE_HEAD') throw e;
    }
  }
  throw new ApiError('TIMEOUT', `Landing on ${ref} is still queued; check ticket ${ticket}`, {
    ticket,
  });
}
