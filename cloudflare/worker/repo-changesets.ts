// Changeset landing (Scion model) and the Git view it leaves behind. Landing a
// path-disjoint commit appends its changeset to the authority's log: no Git objects and no
// merge commit on the landing path. A projector builds main's Git commit for each
// changeset version afterwards, deterministically (same versions, same ids), so it can
// run in the background, on demand for a read, or twice at once without harm. Main's
// history keeps the pushed commits: a lone changeset on main's head becomes main as
// itself, anything else a merge of main and the landed commits (platform_project.rs).
import { dispatchRuns } from './repo-checks';
import { dispatchDerive } from './repo-derived';
import { refreshHead } from './repo-head';
import type { CachedObject } from './repo-objects';
import { caller, type Json, RepoContext, withTrees } from './repo-ops';
import { dispatchObjects, dispatchProjection } from './repo-projection';
import { shardLanded } from './repo-shards';
import { timed } from './repo-timing';
import type { Env } from './types';

/** `batch` (the default): landers submit their commit's shard record to the branch's
 * combiner, which lands every waiting submission in one authority call (an adopted commit,
 * which has no shard record, or an unreachable combiner, falls back to `changeset`).
 * `changeset`: landings queue in the authority and the combiner lands them a batch at a
 * time. */
export type LandMode = 'changeset' | 'batch';

/** A write-path switch: the deployment's default, or what a request picked where the
 * deployment allows a per-request choice (benchmarks compare modes on one deploy). */
export function writeSwitch<T extends string>(
  env: Env,
  values: readonly T[],
  fallback: T,
  configured: string | undefined,
  requested?: string | null,
): T {
  const pick = (m?: string | null) => values.find((value) => value === m);
  return (env.LAND_MODE_OVERRIDE === 'true' && pick(requested)) || pick(configured) || fallback;
}

export const landMode = (env: Env, requested?: string | null): LandMode =>
  writeSwitch(env, ['changeset', 'batch'] as const, 'batch', env.LAND_MODE, requested);

const PROJECTION_ROUNDS = 64;

/**
 * The plan's landed commits from their shards, one call each: their staged objects (usually
 * still there: fetched at once rather than walking the tiers object by object; drained ones
 * are in R2, and the authority is never asked, being busy landing), and the records of
 * those the authority does not hold yet (batch landing never adopts). Main's history names
 * each pushed commit, so the record call adopts them first (in landing order, parents
 * first); each one found is marked recorded for compute. A record already gone leaves its
 * commit out of main's history (its files still land).
 */
async function fromShards(env: Env, repo: string, items: Json[]) {
  const landed = new Map<string, Json[]>();
  for (const step of items)
    for (const commit of step.landed as Json[])
      landed.set(commit.id, [...(landed.get(commit.id) ?? []), commit]);
  const found = await Promise.all(
    [...landed].map(async ([id, entries]) => {
      const wanted = entries.some((commit) => !commit.recorded);
      const { objects, record } = await shardLanded(env, repo, id, wanted);
      if (!wanted || !record) return { objects, record: null };
      for (const commit of entries) commit.recorded = true;
      return { objects, record };
    }),
  );
  return {
    staged: found.flatMap((f) => f.objects),
    records: found.flatMap((f) => (f.record ? [f.record] : [])),
  };
}

/**
 * Builds and records the Git commits of every unprojected changeset (oldest first, up to
 * 64 versions per round). The authority stages their new objects as it records them, and
 * the object projector writes them to R2. Returns how many versions this call projected.
 */
export async function projectChangesets(env: Env, repo: string): Promise<number> {
  const projector = new RepoContext(env, repo, caller(env, repo, { _system: 'projection' }));
  let projected = 0;
  const refs = new Set<string>();
  // The previous round's trees, carried into the next round.
  let previous: CachedObject[] = [];
  const caching: Promise<unknown>[] = [];
  for (let round = 0; round < PROJECTION_ROUNDS; round++) {
    const plan = await projector.call({ op: 'repo_changeset_plan' });
    if (!plan.items?.length) break;
    const objects = await projector.objects();
    const { staged, records } = await timed('project.staged', () =>
      fromShards(env, repo, plan.items),
    );
    const known = new Map([...previous, ...staged].map((o) => [o.id, o]));
    const built = await timed('project.compute', () =>
      withTrees(objects, { op: 'project_changesets', head: plan.head, items: plan.items }, known),
    );
    let recorded: Json;
    try {
      // The authority stages the new objects with the record (R2 follows, off this path).
      recorded = await projector.call({
        op: 'repo_changeset_record',
        ref: plan.ref,
        from: plan.head.id,
        items: built.projected,
        records,
      });
    } catch (e: any) {
      // Another projector recorded these versions first, or a landed commit was adopted
      // after this plan: plan again.
      if (e?.code !== 'STALE_HEAD') throw e;
      continue;
    }
    // Another projector recorded these exact versions first: nothing new to announce.
    if (recorded.already) continue;
    projected += built.projected.length;
    refs.add(String(plan.ref));
    if (recorded.dispatch_objects)
      await dispatchObjects(env, repo).catch((e) =>
        console.warn(`object drain request failed: ${e?.message ?? e}`),
      );
    // Post-land checks on main's new head (the combined result of the landed work).
    await dispatchRuns(env, repo, recorded.check_runs).catch((e) =>
      console.warn(`check dispatch failed: ${e?.message ?? e}`),
    );
    // Reads at the latest version walk the head's new trees: cache them in R2 now (beside
    // the next round) rather than have every reader ask the authority's staged copies.
    const head = new Set((built.projected.at(-1).raw as Json[]).map((o) => o.id));
    const fresh = (built.objects as CachedObject[]).filter((o) => head.has(o.id));
    caching.push(timed('project.cache', () => objects.cache(fresh)));
    previous = (built.objects as CachedObject[]).filter((o) => o.kind === 'tree');
  }
  await Promise.all(caching);
  // The branch moved in Git: project it to Artifacts and derive its search segments and
  // change log (a lost message only delays them), and republish its head.
  if (projected)
    await Promise.all([
      Promise.all([
        dispatchProjection(env, repo),
        ...[...refs].map((ref) => dispatchDerive(env, repo, ref)),
      ]).catch((e) => console.warn(`dispatch after projection failed: ${e?.message ?? e}`)),
      refreshHead(env, repo),
    ]);
  return projected;
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

type Projector = {
  catchUp(repo: string): Promise<number>;
  kick(repo: string): Promise<void>;
};

/** The repository's projector (one per repository), when the deployment has one. */
function projector(env: Env, repo: string): Projector | null {
  const namespace = env.LAND_COMBINERS;
  if (!namespace) return null;
  const stub = namespace.get(
    namespace.idFromName(`${repo}#projector`),
  ) as unknown as Partial<Projector>;
  return typeof stub.catchUp === 'function' ? (stub as Projector) : null;
}

/** Waits until every changeset landed so far is projected (a read at the latest version
 * needs its Git commit). Concurrent waiters share one projection. */
export async function awaitProjection(env: Env, repo: string) {
  const shared = projector(env, repo);
  await timed('project.wait', () => (shared ? shared.catchUp(repo) : projectChangesets(env, repo)));
}

/** Starts projecting in the background after changesets landed (without a projector,
 * as locally, the lander projects before it answers). */
export async function kickProjection(env: Env, repo: string) {
  const shared = projector(env, repo);
  if (shared) return shared.kick(repo);
  await projectChangesets(env, repo);
}

export type ChangesetStep = { settled: Json[]; wait?: number; more: boolean; slow: boolean };

/**
 * Lands one batch of queued, path-disjoint landings on `ref` as changesets (one authority
 * call), settling them and stale reads; items on the same files stay queued for merges.
 */
export async function landChangesets(merger: RepoContext, ref: string): Promise<ChangesetStep> {
  const out = await merger.call({ op: 'repo_land_changesets', ref });
  if (out.wait) return { settled: [], wait: out.retry_after_ms ?? 250, more: true, slow: false };
  if (out.landed.length)
    await Promise.all([
      kickProjection(merger.env, merger.repo).catch((e) =>
        console.warn(`projection kick failed: ${e?.message ?? e}`),
      ),
      refreshHead(merger.env, merger.repo),
    ]);
  return { settled: [...out.landed, ...out.failed], more: out.more, slow: out.slow.length > 0 };
}
