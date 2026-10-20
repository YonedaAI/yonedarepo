// The land combiner: one per protected branch. Landers that need a merge enqueue with the
// authority, then wait here instead of polling it; the combiner alone drains the queue
// (changesets first in changeset mode, then batch merges built by stateless compute in
// this Worker, each landed with one compare-and-swap and one log entry) and answers every
// waiter whose ticket it settled. Waiting is held in memory: if the combiner is evicted
// its waiters fall back to polling, and the queue and every landing stay in the
// authority, so nothing is lost. In batch mode landers submit their commit's shard
// records here instead, and each step lands every waiting submission in one authority
// call (nothing is queued in the authority: an evicted combiner's landers resubmit, and
// a resubmitted landing answers with its version). The same class, named `<repo>#projector`
// and `<repo>#head`, is the repository's changeset projector and published-head holder.
import { DurableObject } from 'cloudflare:workers';
import {
  kickProjection,
  type LandMode,
  landChangesets,
  projectChangesets,
} from './repo-changesets';
import { HeadHolder, refreshHead } from './repo-head';
import { claimCommand } from './repo-land-poll';
import { landBatch, type Settled } from './repo-merge';
import { caller, type Json, RepoContext } from './repo-ops';
import type { Env } from './types';

const SETTLED_KEPT = 10_000;
const RETRY_MS = 250;
const SUBMIT_BATCH = 256;
type Target = { repo: string; ref: string };
type Submission = { item: Json; resolve: (outcome: Json | null) => void };

/**
 * The combiner's logic, apart from the Durable Object so tests can run it in-process with
 * their own bindings. `schedule(ms)` asks for one `step()` after `ms`.
 */
export class LandBatcher {
  #waiters = new Map<number, ((settled: Settled | null) => void)[]>();
  #settled = new Map<number, Settled>();
  #submissions: Submission[] = [];
  target?: Target;
  mode: LandMode = 'combiner';

  constructor(
    private readonly env: Env,
    private readonly schedule: (ms: number) => Promise<void>,
  ) {}

  /**
   * Resolves with `ticket`'s outcome once a batch settles it, or null after `timeoutMs`
   * (the caller checks the authority and waits again).
   */
  async wait(target: Target, ticket: number, timeoutMs: number, mode: LandMode = 'combiner') {
    const done = this.#settled.get(ticket);
    if (done) return done;
    this.target = target;
    this.mode = mode;
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
      const submission = { item, resolve };
      this.#submissions.push(submission);
      setTimeout(() => {
        this.#submissions = this.#submissions.filter((s) => s !== submission);
        resolve(null);
      }, timeoutMs);
    });
    await this.schedule(0);
    return outcome;
  }

  /** One authority call for every waiting submission; deferred ones ride the next. */
  async #landSubmitted(merger: RepoContext, ref: string) {
    const batch = this.#submissions.splice(0, SUBMIT_BATCH);
    let out: Json;
    try {
      out = await merger.call({ op: 'repo_land_submitted', ref, items: batch.map((s) => s.item) });
    } catch (e) {
      this.#submissions.unshift(...batch);
      throw e;
    }
    const again: Submission[] = [];
    for (const [i, submission] of batch.entries()) {
      if (out.items[i].status === 'deferred') again.push(submission);
      else submission.resolve(out.items[i]);
    }
    this.#submissions.unshift(...again);
    if (out.items.some((r: Json) => r.status === 'landed'))
      await Promise.all([
        kickProjection(merger.env, merger.repo).catch((e) =>
          console.warn(`projection kick failed: ${e?.message ?? e}`),
        ),
        refreshHead(merger.env, merger.repo),
      ]);
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
    if (this.mode === 'changeset') {
      // Path-disjoint work lands as changesets, a batch per step, before any merge.
      const step = await landChangesets(merger, target.ref);
      this.#settle(step.settled as Settled[]);
      if (step.wait !== undefined || step.more) {
        await this.schedule(Math.min(step.wait ?? 0, RETRY_MS));
        return;
      }
    }
    const claim = await merger.call(claimCommand(target.ref, this.mode));
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

/** Projects one repository's changesets, one projection at a time; waiters share it. */
export class ProjectionRunner {
  #running: Promise<number> | null = null;
  #again = false;

  constructor(private readonly env: Env) {}

  /** Resolves once every changeset landed before the call is projected. */
  async catchUp(repo: string): Promise<number> {
    // A projection already running may have planned before this caller's changesets.
    if (this.#running) {
      this.#again = true;
      await this.#running.catch(() => 0);
    }
    this.#running ??= (async () => {
      let projected = 0;
      do {
        this.#again = false;
        projected += await projectChangesets(this.env, repo);
      } while (this.#again);
      return projected;
    })().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }
}

export class LandCombiner extends DurableObject<Env> {
  #batcher = new LandBatcher(this.env, async (ms) => {
    const at = Date.now() + ms;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  });
  #projection = new ProjectionRunner(this.env);
  #head = new HeadHolder(this.env);

  async wait(repo: string, ref: string, ticket: number, timeoutMs: number, mode?: LandMode) {
    await this.ctx.storage.put('target', { repo, ref });
    return this.#batcher.wait({ repo, ref }, ticket, timeoutMs, mode);
  }

  async submit(repo: string, ref: string, item: Json, timeoutMs: number) {
    await this.ctx.storage.put('target', { repo, ref });
    return this.#batcher.submit({ repo, ref }, item, timeoutMs);
  }

  /** Head role: main's published head, at least at `minVersion`. */
  head(repo: string, minVersion: number) {
    return this.#head.head(repo, minVersion);
  }

  /** Head role: the head is stale (a landing, projection or access change). */
  refresh(repo: string) {
    this.#head.refresh(repo);
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
    await this.#batcher.step();
  }
}
