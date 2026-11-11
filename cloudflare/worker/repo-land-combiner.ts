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
import { cellEnv } from './cell-env';
import { log } from './log';
import { type OperationCarrier, withCarrier } from './operation-carrier';
import { operationLinks } from './operation-links';
import { observeOperation } from './operation-observation';
import { ProjectionRunner } from './repo-changesets';
import { HeadHolder } from './repo-head-holder';
import { LandBatcher, type Target } from './repo-land-batcher';
import type { Json } from './repo-ops';
import { placedHere } from './repo-region-hint';
import { servedHere } from './repo-region-serve';
import { repoRpcAnswer } from './repo-rpc';
import { RefsHolder } from './repo-snapshots';
import { inScope } from './request-scope';
import type { Env } from './types';

export class LandCombiner extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, cellEnv(env));
  }

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
    this.#running = operationLinks
      .run(undefined, () =>
        inScope({ env: this.env, source: 'queue' }, async () => {
          do {
            this.#again = false;
            await this.#batcher.step();
          } while (this.#again);
        }),
      )
      .catch((e) => log.warn('land.step_failed', { repo: this.#batcher.target?.repo, error: e }))
      .finally(() => {
        this.#running = null;
      });
  }
  #projection = new ProjectionRunner(this.env);
  #head = new HeadHolder(this.env, this.ctx);
  #refs = new RefsHolder(this.env, this.ctx);

  async wait(repo: string, ref: string, ticket: number, timeoutMs: number) {
    await this.ctx.storage.put('target', { repo, ref });
    return this.#batcher.wait({ repo, ref }, ticket, timeoutMs);
  }

  async submit(
    repo: string,
    ref: string,
    item: Json,
    timeoutMs: number,
    observation?: OperationCarrier,
  ) {
    await this.ctx.storage.put('target', { repo, ref });
    return this.#batcher.submit({ repo, ref }, item, timeoutMs, observation);
  }

  /** Head role: main's published head, at least at `minVersion` (with the access snapshot
   * when it differs from the caller's `accessVersion`). */
  head(
    repo: string,
    minVersion: number,
    since?: number,
    accessVersion?: string | null,
    observation?: OperationCarrier,
  ) {
    return withCarrier(this.env, observation, () =>
      observeOperation(
        this.env,
        { kind: 'repository', operation: 'holder.head', repo, actor: 'system' },
        async () => repoRpcAnswer(this.#head.head(repo, minVersion, since, accessVersion)),
      ),
    );
  }

  /** Head role: the trees along `paths` from root tree `root` (see HeadHolder.trees). */
  trees(
    repo: string,
    root: string,
    paths: string[],
    commit?: string,
    observation?: OperationCarrier,
  ) {
    return withCarrier(this.env, observation, () =>
      observeOperation(
        this.env,
        { kind: 'repository', operation: 'holder.trees', repo, actor: 'system' },
        async () => this.#head.trees(repo, root, paths, commit),
      ),
    );
  }

  /** Head role: the access snapshot (live token digests), versioned by `access_version`. */
  access(repo: string, observation?: OperationCarrier) {
    return withCarrier(this.env, observation, () =>
      observeOperation(
        this.env,
        { kind: 'repository', operation: 'holder.access', repo, actor: 'system' },
        async () => repoRpcAnswer(this.#head.access(repo)),
      ),
    );
  }

  /** Head role: every ref, read from the authority at most `REFS_MS` ago and at least at
   * `minVersion` (repo-snapshots.ts). */
  refs(repo: string, minVersion: number, observation?: OperationCarrier) {
    return withCarrier(this.env, observation, () =>
      observeOperation(
        this.env,
        { kind: 'repository', operation: 'holder.refs', repo, actor: 'system' },
        async () => repoRpcAnswer(this.#refs.refs(repo, minVersion)),
      ),
    );
  }

  /** Head role: the head is stale (a landing, projection or access change; after an access
   * change it answers once the held head is dropped and reloaded). */
  refresh(repo: string, access = false) {
    this.#refs.forget();
    return this.#head.refresh(repo, access);
  }

  /** REGION_HINT_TEST only: the platform's routes, run here (repo-region-serve.ts). */
  fetch(request: Request) {
    return servedHere(this.ctx, this.env, request);
  }

  /** `keep` persists initial placement; other calls read the diagnostic data center. */
  where(keep = false) {
    return placedHere(this.ctx.storage, keep);
  }

  /** The repository was erased: forgets its names (`target`, `projector`), its alarm and
   * what this instance holds in memory. Nothing writes here again: every path that would
   * first needs the repository's authority or a commit shard, which answer GONE. */
  async erase() {
    this.#batcher.target = undefined;
    this.#head = new HeadHolder(this.env, this.ctx);
    this.#refs = new RefsHolder(this.env, this.ctx);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Projector role: waits until this repository's changesets are projected. */
  async catchUp(repo: string, observation?: OperationCarrier) {
    await this.ctx.storage.put('projector', repo);
    return withCarrier(this.env, observation, () =>
      observeOperation(
        this.env,
        { kind: 'repository', operation: 'holder.catchUp', repo, actor: 'system' },
        async () => this.#projection.catchUp(repo),
      ),
    );
  }

  /** Projector role: projects in the background (an alarm, so it survives the caller). */
  async kick(repo: string) {
    await this.ctx.storage.put('projector', repo);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm() {
    const repo = await this.ctx.storage.get<string>('projector');
    if (repo) {
      await inScope({ env: this.env, source: 'alarm' }, () =>
        observeOperation(
          this.env,
          {
            kind: 'background',
            source: 'alarm',
            operation: 'projection.alarm',
            actor: 'system',
            repo,
          },
          () => this.#projection.catchUp(repo),
        ),
      );
      return;
    }
    this.#batcher.target ??= await this.ctx.storage.get<Target>('target');
    this.#run();
    await this.#running;
  }
}
