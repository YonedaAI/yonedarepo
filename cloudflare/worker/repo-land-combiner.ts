// The land combiner: one per protected branch. Landers that need a merge enqueue with the
// authority, then wait here instead of polling it; the combiner alone drains the queue
// (changesets first in changeset mode, then batch merges built by stateless compute in
// this Worker, each landed with one compare-and-swap and one log entry) and answers every
// waiter whose ticket it settled. Waiting is held in memory: if the combiner is evicted
// its waiters fall back to polling, and the queue and every landing stay in the
// authority, so nothing is lost. The same class, named `<repo>#projector`, is the
// repository's changeset projector.
import { DurableObject } from 'cloudflare:workers';
import { type LandMode, landChangesets, projectChangesets } from './repo-changesets';
import { claimCommand } from './repo-land-poll';
import { landBatch, type Settled } from './repo-merge';
import { caller, type Json, RepoContext } from './repo-ops';
import type { Env } from './types';

const SETTLED_KEPT = 10_000;
const RETRY_MS = 250;
type Target = { repo: string; ref: string };

/**
 * The combiner's logic, apart from the Durable Object so tests can run it in-process with
 * their own bindings. `schedule(ms)` asks for one `step()` after `ms`.
 */
export class LandBatcher {
  #waiters = new Map<number, ((settled: Settled | null) => void)[]>();
  #settled = new Map<number, Settled>();
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

  /** Builds one batch (each step has its own subrequest budget), then asks for the next. */
  async step() {
    const target = this.target;
    if (!target) return;
    const merger = new RepoContext(
      this.env,
      target.repo,
      caller(this.env, target.repo, { _system: 'merge' }),
    );
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

  async wait(repo: string, ref: string, ticket: number, timeoutMs: number, mode?: LandMode) {
    await this.ctx.storage.put('target', { repo, ref });
    return this.#batcher.wait({ repo, ref }, ticket, timeoutMs, mode);
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
