// The land combiner's logic (repo-land-combiner.ts), apart from the Durable Object so tests can run
// it in-process with their own bindings: submissions and tickets, each step landing what waits.
import { noteFull } from './durable';
import { log, warned } from './log';
import { kickProjection, landChangesets } from './repo-changesets';
import { refreshHead } from './repo-head';
import { claimCommand } from './repo-land-poll';
import { landBatch, type Settled } from './repo-merge';
import { caller, type Json, RepoContext } from './repo-ops';
import type { Env } from './types';

const SETTLED_KEPT = 10_000;
const RETRY_MS = 250;
const SUBMIT_BATCH = 256;
export type Target = { repo: string; ref: string };
type Submission = { item: Json; at: number; resolve: (outcome: Json | null) => void };

// Superfan counts land.timed_out and the land.*_failed events below by name.

/**
 * The combiner's logic, apart from the Durable Object so tests can run it in-process with
 * their own bindings. `schedule(ms)` asks for one `step()` after `ms`.
 */
export class LandBatcher {
  #waiters = new Map<number, ((settled: Settled | null) => void)[]>();
  #settled = new Map<number, Settled>();
  #submissions: Submission[] = [];
  /** Notifications sent without holding up landing, until they finish. */
  #background = new Set<Promise<unknown>>();
  target?: Target;

  constructor(
    private readonly env: Env,
    private readonly schedule: (ms: number) => Promise<void>,
  ) {}

  /**
   * Resolves with `ticket`'s outcome once a batch settles it, or null after `timeoutMs`
   * (the caller checks the authority and waits again).
   */
  async wait(target: Target, ticket: number, timeoutMs: number) {
    const done = this.#settled.get(ticket);
    if (done) return done;
    this.target = target;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const settled = new Promise<Settled | null>((resolve) => {
      const list = this.#waiters.get(ticket) ?? [];
      list.push(resolve);
      this.#waiters.set(ticket, list);
      deadline = setTimeout(() => {
        const waiting = this.#waiters.get(ticket) ?? [];
        if (waiting.includes(resolve))
          log.warn('land.timed_out', { repo: target.repo, phase: 'wait' });
        const left = waiting.filter((r) => r !== resolve);
        if (left.length) this.#waiters.set(ticket, left);
        else this.#waiters.delete(ticket);
        resolve(null);
      }, timeoutMs);
    }).finally(() => clearTimeout(deadline));
    await this.schedule(0);
    return settled;
  }

  /**
   * Batch mode: lands `item` (a lander's credentials and its commit's shard records) in
   * the next batch; resolves with its outcome, or null after `timeoutMs` (resubmit).
   */
  async submit(target: Target, item: Json, timeoutMs: number) {
    this.target = target;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const outcome = new Promise<Json | null>((resolve) => {
      const submission = { item, at: Date.now(), resolve };
      this.#submissions.push(submission);
      deadline = setTimeout(() => {
        if (this.#submissions.includes(submission))
          log.warn('land.timed_out', { repo: target.repo, phase: 'submit' });
        this.#submissions = this.#submissions.filter((s) => s !== submission);
        resolve(null);
      }, timeoutMs);
    }).finally(() => clearTimeout(deadline));
    await this.schedule(0);
    return outcome;
  }

  /** Resolves when the notifications already sent have finished. */
  async idle() {
    await Promise.all(this.#background);
  }

  /** One authority call for every waiting submission; deferred ones ride the next. */
  async #landSubmitted(merger: RepoContext, ref: string) {
    const batch = this.#submissions.splice(0, SUBMIT_BATCH);
    let out: Json;
    const started = Date.now();
    try {
      out = await merger.call({ op: 'repo_land_submitted', ref, items: batch.map((s) => s.item) });
    } catch (e: any) {
      // A full database refuses them again however often they are sent: answer each now.
      if (e?.code === 'REPO_FULL') {
        for (const s of batch) s.resolve({ status: 'failed', code: e.code, message: e.message });
        return;
      }
      this.#submissions.unshift(...batch);
      throw e;
    }
    // Each lander reports its batch's authority call (size and wall time) in Server-Timing.
    const timing = { size: batch.length, ms: Date.now() - started };
    const again: Submission[] = [];
    if (out.items.some((r: Json) => r.code === 'REPO_FULL'))
      noteFull(merger.repo, 'repo_land_submitted');
    for (const [i, submission] of batch.entries()) {
      if (out.items[i].status === 'deferred') again.push(submission);
      else
        submission.resolve({ ...out.items[i], batch: timing, queued_ms: started - submission.at });
    }
    this.#submissions.unshift(...again);
    // The projector and the head holder hear about it without holding up the next batch.
    if (out.items.some((r: Json) => r.status === 'landed')) {
      const notified = Promise.all([
        kickProjection(merger.env, merger.repo).catch((e) =>
          log.warn('projection.kick_failed', { error: e }),
        ),
        refreshHead(merger.env, merger.repo),
      ]).finally(() => this.#background.delete(notified));
      this.#background.add(notified);
    }
  }

  /** Builds one batch (each step has its own subrequest budget), then asks for the next. */
  async step() {
    const target = this.target;
    if (!target) return;
    const merger = new RepoContext(
      this.env,
      target.repo,
      caller(this.env, target.repo, { _system: 'merge' }),
    );
    if (this.#submissions.length) {
      try {
        await this.#landSubmitted(merger, target.ref);
      } catch (e: any) {
        log.warn('land.submitted_batch_failed', { repo: target.repo, error: e });
        await this.schedule(1000);
        return;
      }
      // Queued merge-path tickets still get their turn between submitted batches.
      if (this.#waiters.size === 0) {
        await this.schedule(0);
        return;
      }
    }
    // Path-disjoint queued work lands as changesets, a batch per step, before any merge.
    const step = await landChangesets(merger, target.ref);
    this.#settle(step.settled as Settled[]);
    if (step.wait !== undefined || step.more) {
      await this.schedule(Math.min(step.wait ?? 0, RETRY_MS));
      return;
    }
    const claim = await merger.call(claimCommand(target.ref));
    if (claim.wait) {
      // A polling lander (a fallback) holds the lease; look again shortly.
      await this.schedule(Math.min(claim.retry_after_ms ?? RETRY_MS, RETRY_MS));
      return;
    }
    if (claim.empty) {
      await this.#reconcile(merger);
      return;
    }
    try {
      this.#settle((claim.items?.length ? await landBatch(merger, claim) : claim.failed) ?? []);
      if (!claim.items?.length)
        await merger.call({ op: 'repo_land_release', ref: target.ref, epoch: claim.epoch });
    } catch (e: any) {
      await merger
        .call({ op: 'repo_land_release', ref: target.ref, epoch: claim.epoch })
        .catch(warned('land.release_failed', { repo: target.repo }));
      // A lost compare-and-swap rebuilds at once; anything else waits a moment.
      if (e?.code !== 'STALE_HEAD') log.warn('land.batch_failed', { repo: target.repo, error: e });
      await this.schedule(e?.code === 'STALE_HEAD' ? 0 : 1000);
      return;
    }
    await this.schedule(0);
  }

  /** The queue is empty: tickets still awaited were settled elsewhere (a polling lander). */
  async #reconcile(merger: RepoContext) {
    for (const ticket of [...this.#waiters.keys()]) {
      // A status that cannot be read stays awaited: the next empty queue asks again.
      const status: Json | null = await merger
        .call({ op: 'repo_land_status', ticket })
        .catch(() => null);
      if (status && status.status !== 'pending')
        this.#settle([{ ticket, status: status.status, ref: status.ref, result: status.result }]);
    }
  }

  #settle(settled: Settled[]) {
    for (const s of settled) {
      this.#settled.set(s.ticket, s);
      for (const resolve of this.#waiters.get(s.ticket) ?? []) resolve(s);
      this.#waiters.delete(s.ticket);
    }
    for (const old of this.#settled.keys()) {
      if (this.#settled.size <= SETTLED_KEPT) break;
      this.#settled.delete(old);
    }
  }
}
