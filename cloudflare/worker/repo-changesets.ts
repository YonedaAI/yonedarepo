// Changeset landing (Scion model) and the Git view it leaves behind. Landing a
// path-disjoint commit appends its changeset to the authority's log: no Git objects and no
// merge commit on the landing path. A projector builds main's Git commit for each
// changeset version afterwards, deterministically (same versions, same ids), so it can
// run in the background, on demand for a read, or twice at once without harm.
import { deferred } from './background';
import { stagedOf } from './repo-merge';
import type { CachedObject } from './repo-objects';
import { caller, type Json, RepoContext, withTrees } from './repo-ops';
import { dispatchObjects, dispatchProjection } from './repo-projection';
import { timed } from './repo-timing';
import type { Env } from './types';

export type LandMode = 'poll' | 'combiner' | 'changeset';
const MODES: LandMode[] = ['poll', 'combiner', 'changeset'];

/** The deployment's landing mode; a request may pick another only where the deployment
 * allows it (for benchmarks on one deploy). */
export function landMode(env: Env, requested?: string | null): LandMode {
  const pick = (m?: string | null) => MODES.find((mode) => mode === m);
  return (
    (env.LAND_MODE_OVERRIDE === 'true' && pick(requested)) || pick(env.LAND_MODE) || 'combiner'
  );
}

const PROJECTION_ROUNDS = 64;

/**
 * Builds and records the Git commits of every unprojected changeset (oldest first, up to
 * 64 versions per round). The authority stages their new objects as it records them, and
 * the object projector writes them to R2. Returns how many versions this call projected.
 */
export async function projectChangesets(env: Env, repo: string): Promise<number> {
  const projector = new RepoContext(env, repo, caller(env, repo, { _system: 'projection' }));
  let projected = 0;
  // The previous round's head trees, carried into the next round.
  let previous: CachedObject[] = [];
  for (let round = 0; round < PROJECTION_ROUNDS; round++) {
    const plan = await projector.call({ op: 'repo_changeset_plan' });
    if (!plan.items?.length) break;
    const objects = await projector.objects();
    // Landed commits' objects are usually still staged (in their commit shard): fetch each
    // commit's in one call rather than walking the tiers object by object.
    const staged = await timed('project.staged', () =>
      Promise.all((plan.items as Json[]).map((item) => stagedOf(projector, item.commit.id))),
    );
    const known = new Map([...previous, ...staged.flat()].map((o) => [o.id, o]));
    const built = await timed('project.compute', () =>
      withTrees(objects, { op: 'project_changesets', head: plan.head, items: plan.items }, known),
    );
    // The authority stages the new objects with the record (R2 follows, off this path).
    await timed('project.cache', () => objects.cache(built.objects, 'edge'));
    let recorded: Json;
    try {
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
    const head = built.projected.at(-1);
    const tip = new Set([head.commit, head.tree]);
    previous = (built.objects as CachedObject[]).filter((o) => o.kind === 'tree' || tip.has(o.id));
  }
  // The branch moved in Git: project it to Artifacts. A lost message only delays that.
  if (projected)
    await dispatchProjection(env, repo).catch((e) =>
      console.warn(`dispatch after projection failed: ${e?.message ?? e}`),
    );
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
