// Changeset landing (Scion model) and the Git view it leaves behind. Landing a
// path-disjoint commit appends its changeset to the authority's log: no Git objects and no
// merge commit on the landing path. A projector builds main's Git commit for each
// changeset version afterwards, deterministically (same versions, same ids), so it can
// run in the background, on demand for a read, or twice at once without harm.
import { deferred } from './background';
import { refreshHead } from './repo-head';
import type { CachedObject } from './repo-objects';
import { caller, type Json, RepoContext, withTrees } from './repo-ops';
import { dispatchObjects, dispatchProjection } from './repo-projection';
import { shardStagedOf } from './repo-shards';
import { timed } from './repo-timing';
import type { Env } from './types';

export type LandMode = 'poll' | 'combiner' | 'changeset' | 'batch';

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
  writeSwitch(
    env,
    ['poll', 'combiner', 'changeset', 'batch'] as const,
    'combiner',
    env.LAND_MODE,
    requested,
  );

const PROJECTION_ROUNDS = 64;

/**
 * Builds and records the Git commits of every unprojected changeset (oldest first, up to
 * 64 versions per round). The authority stages their new objects as it records them, and
 * the object projector writes them to R2. Returns how many versions this call projected.
 */
export async function projectChangesets(env: Env, repo: string): Promise<number> {
  const projector = new RepoContext(env, repo, caller(env, repo, { _system: 'projection' }));
  let projected = 0;
  // The previous round's trees, carried into the next round.
  let previous: CachedObject[] = [];
  const caching: Promise<unknown>[] = [];
  for (let round = 0; round < PROJECTION_ROUNDS; round++) {
    const plan = await projector.call({ op: 'repo_changeset_plan' });
    if (!plan.items?.length) break;
    const objects = await projector.objects();
    // Landed commits' objects are usually still staged in their commit shard: fetch each
    // commit's in one call rather than walking the tiers object by object. Drained ones are
    // in R2 already (never ask the authority: it is busy landing).
    const staged = await timed('project.staged', () =>
      Promise.all(
        [
          ...new Set(
            (plan.items as Json[]).flatMap((step) => step.changes.map((c: Json) => c.source.id)),
          ),
        ].map((commit) => shardStagedOf(env, repo, commit)),
      ),
    );
    const known = new Map([...previous, ...staged.flat()].map((o) => [o.id, o]));
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
      });
    } catch (e: any) {
      // Another projector recorded these versions first: plan again from its head.
      if (e?.code !== 'STALE_HEAD') throw e;
      continue;
    }
    projected += built.projected.length;
    if (recorded.dispatch_objects)
      await dispatchObjects(env, repo).catch((e) =>
        console.warn(`object drain request failed: ${e?.message ?? e}`),
      );
    // Reads at the latest version walk the head's new trees: cache them in R2 now (beside
    // the next round) rather than have every reader ask the authority's staged copies.
    const head = new Set((built.projected.at(-1).raw as Json[]).map((o) => o.id));
    const fresh = (built.objects as CachedObject[]).filter((o) => head.has(o.id));
    caching.push(timed('project.cache', () => objects.cache(fresh)));
    previous = (built.objects as CachedObject[]).filter((o) => o.kind === 'tree');
  }
  await Promise.all(caching);
  // The branch moved in Git: project it to Artifacts (a lost message only delays that),
  // and republish its head.
  if (projected)
    await Promise.all([
      dispatchProjection(env, repo).catch((e) =>
        console.warn(`dispatch after projection failed: ${e?.message ?? e}`),
      ),
      refreshHead(env, repo),
    ]);
  return projected;
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

/** Starts projecting in the background after changesets landed. */
export async function kickProjection(env: Env, repo: string) {
  const shared = projector(env, repo);
  if (shared) return shared.kick(repo);
  if (!deferred(() => projectChangesets(env, repo))) await projectChangesets(env, repo);
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
    await kickProjection(merger.env, merger.repo).catch((e) =>
      console.warn(`projection kick failed: ${e?.message ?? e}`),
    );
  return { settled: [...out.landed, ...out.failed], more: out.more, slow: out.slow.length > 0 };
}
