// The land combiner: one per protected branch. In batch mode landers submit their
// commit's shard record here, and each step lands every waiting submission in one
// authority call (nothing is queued in the authority: an evicted combiner's landers
// resubmit, and a resubmitted landing answers with its version). Landings queued in the
// authority (changeset mode, and same-file work, which needs a merge) wait here too: the
// combiner lands path-disjoint ones as changesets and builds batch merges for the rest
// (stateless compute in this Worker, one compare-and-swap and one log entry each), and
// answers every waiter whose ticket it settled. Waiting is held in memory: if the combiner
// is evicted its ticket waiters fall back to polling, so nothing is lost. The same class, named `<repo>#projector`
// and `<repo>#head`, is the repository's changeset projector and published-head holder.
import { DurableObject } from 'cloudflare:workers';
import { kickProjection, landChangesets, ProjectionRunner } from './repo-changesets';
import { refreshHead } from './repo-head';
import { HeadHolder } from './repo-head-holder';
import { claimCommand } from './repo-land-poll';
import { landBatch, type Settled } from './repo-merge';
import { caller, type Json, RepoContext } from './repo-ops';
import type { Env } from './types';

const SETTLED_KEPT = 10_000;
const RETRY_MS = 250;
const SUBMIT_BATCH = 256;
type Target = { repo: string; ref: string };
type Submission = { item: Json; at: number; resolve: (outcome: Json | null) => void };

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
    const settled = new Promise<Settled | null>((resolve) => {
      const list = this.#waiters.get(ticket) ?? [];
      list.push(resolve);
      this.#waiters.set(ticket, list);
      setTimeout(() => {
        const left = (this.#waiters.get(ticket) ?? []).filter((r) => r !== resolve);
        if (left.length) this.#waiters.set(ticket, left);
        else this.#waiters.delete(ticket);
        resolve(null);
      }, timeoutMs);
    });
    await this.schedule(0);
    return settled;
  }

  /**
   * Batch mode: lands `item` (a lander's credentials and its commit's shard records) in
   * the next batch; resolves with its outcome, or null after `timeoutMs` (resubmit).
   */
  async submit(target: Target, item: Json, timeoutMs: number) {
    this.target = target;
    const outcome = new Promise<Json | null>((resolve) => {
      const submission = { item, at: Date.now(), resolve };
      this.#submissions.push(submission);
      setTimeout(() => {
        this.#submissions = this.#submissions.filter((s) => s !== submission);
        resolve(null);
      }, timeoutMs);
    });
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
    } catch (e) {
      this.#submissions.unshift(...batch);
      throw e;
    }
    // Each lander reports its batch's authority call (size and wall time) in Server-Timing.
    const timing = { size: batch.length, ms: Date.now() - started };
    const again: Submission[] = [];
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
          console.warn(`projection kick failed: ${e?.message ?? e}`),
        ),
        refreshHead(merger.env, merger.repo, 'landing'),
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
        console.warn(`submitted batch failed: ${e?.code ?? ''} ${e?.message ?? e}`);
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
        .catch(() => {});
      // A lost compare-and-swap rebuilds at once; anything else waits a moment.
      if (e?.code !== 'STALE_HEAD')
        console.warn(`land batch failed: ${e?.code ?? ''} ${e?.message ?? e}`);
      await this.schedule(e?.code === 'STALE_HEAD' ? 0 : 1000);
      return;
    }
    await this.schedule(0);
  }

  /** The queue is empty: tickets still awaited were settled elsewhere (a polling lander). */
  async #reconcile(merger: RepoContext) {
    for (const ticket of [...this.#waiters.keys()]) {
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

export class LandCombiner extends DurableObject<Env> {
  // Steps due now run here at once (one at a time); later ones wait for an alarm, which
  // also restarts the combiner after an eviction.
  #batcher = new LandBatcher(this.env, async (ms) => {
    if (ms === 0) return this.#run();
    const at = Date.now() + ms;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  });
  #running: Promise<void> | null = null;
  #again = false;

  #run() {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = (async () => {
      do {
        this.#again = false;
        await this.#batcher.step();
      } while (this.#again);
    })()
      .catch((e) => console.warn(`land step failed: ${e?.message ?? e}`))
      .finally(() => {
        this.#running = null;
      });
  }
  #projection = new ProjectionRunner(this.env);
  #head = new HeadHolder(this.env);

  async wait(repo: string, ref: string, ticket: number, timeoutMs: number) {
    await this.ctx.storage.put('target', { repo, ref });
    return this.#batcher.wait({ repo, ref }, ticket, timeoutMs);
  }

  async submit(repo: string, ref: string, item: Json, timeoutMs: number) {
    await this.ctx.storage.put('target', { repo, ref });
    return this.#batcher.submit({ repo, ref }, item, timeoutMs);
  }

  /** Head role: main's published head, at least at `minVersion` (with the access snapshot
   * when it differs from the caller's `accessVersion`). */
  head(repo: string, minVersion: number, since?: number, accessVersion?: string | null) {
    return this.#head.head(repo, minVersion, since, accessVersion);
  }

  /** Head role: the access snapshot (live token digests), versioned by `access_version`. */
  access(repo: string) {
    return this.#head.access(repo);
  }

  /** Head role: the head is stale (a landing or projection; with `wait`, an access change,
   * answered once the holder has reloaded). */
  refresh(repo: string, wait = false) {
    return this.#head.refresh(repo, wait);
  }

  /** Projector role: waits until this repository's changesets are projected. */
  async catchUp(repo: string) {
    await this.ctx.storage.put('projector', repo);
    return this.#projection.catchUp(repo);
  }

  /** Projector role: projects in the background (an alarm, so it survives the caller). */
  async kick(repo: string) {
    await this.ctx.storage.put('projector', repo);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm() {
    const repo = await this.ctx.storage.get<string>('projector');
    if (repo) {
      await this.#projection.catchUp(repo);
      return;
    }
    this.#batcher.target ??= await this.ctx.storage.get<Target>('target');
    this.#run();
    await this.#running;
  }
}
