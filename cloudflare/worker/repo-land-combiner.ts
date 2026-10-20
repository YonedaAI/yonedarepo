// The land combiner: one per protected branch. Landers that need a merge enqueue with the
// authority, then wait here instead of polling it; the combiner alone claims the queue,
// builds each batch (stateless merges in this Worker), lands it with one compare-and-swap
// and one log entry, and answers every waiter whose ticket it settled. Waiting is held in
// memory: if the combiner is evicted its waiters fall back to polling, and the queue and
// every landing stay in the authority, so nothing is lost.
import { DurableObject } from 'cloudflare:workers';
import { landBatch, type Settled } from './repo-merge';
import { caller, type Json, RepoContext } from './repo-ops';
import type { Env } from './types';

const SETTLED_KEPT = 10_000;
const RETRY_MS = 250;

export class LandCombiner extends DurableObject<Env> {
  #waiters = new Map<number, ((settled: Settled | null) => void)[]>();
  #settled = new Map<number, Settled>();

  /**
   * Resolves with `ticket`'s outcome once a batch settles it, or null after `timeoutMs`
   * (the caller checks the authority and waits again).
   */
  async wait(repo: string, ref: string, ticket: number, timeoutMs: number) {
    const done = this.#settled.get(ticket);
    if (done) return done;
    await this.ctx.storage.put('target', { repo, ref });
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
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
    return settled;
  }

  /** Builds one batch per invocation (each has its own subrequest budget), then re-arms. */
  async alarm() {
    const target = await this.ctx.storage.get<{ repo: string; ref: string }>('target');
    if (!target) return;
    const merger = new RepoContext(
      this.env,
      target.repo,
      caller(this.env, target.repo, { _system: 'merge' }),
    );
    const claim = await merger.call({ op: 'repo_land_claim', ref: target.ref });
    if (claim.wait) {
      // A polling lander (a fallback) holds the lease; look again shortly.
      await this.ctx.storage.setAlarm(
        Date.now() + Math.min(claim.retry_after_ms ?? RETRY_MS, RETRY_MS),
      );
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
      await this.ctx.storage.setAlarm(Date.now() + (e?.code === 'STALE_HEAD' ? 0 : 1000));
      return;
    }
    await this.ctx.storage.setAlarm(Date.now());
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
