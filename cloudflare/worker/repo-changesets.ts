// Changeset landing (Scion model) and the Git view it leaves behind. Landing a
// path-disjoint commit appends its changeset to the authority's log: no Git objects and no
// merge commit on the landing path. A projector builds main's Git commit for each
// changeset version afterwards, deterministically (same versions, same ids), so it can
// run in the background, on demand for a read, or twice at once without harm.
import { deferred } from './background';
import { caller, type Json, RepoContext, withTrees } from './repo-ops';
import { dispatchProjection } from './repo-projection';
import { putRaw } from './repo-stores';
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
 * 64 versions per round). New objects reach R2, the store of record, before the authority
 * names them. Returns how many versions this call projected.
 */
export async function projectChangesets(env: Env, repo: string): Promise<number> {
  const projector = new RepoContext(env, repo, caller(env, repo, { _system: 'projection' }));
  let projected = 0;
  for (let round = 0; round < PROJECTION_ROUNDS; round++) {
    const plan = await projector.call({ op: 'repo_changeset_plan' });
    if (!plan.items?.length) break;
    const objects = await projector.objects();
    const built = await timed('project.compute', () =>
      withTrees(objects, { op: 'project_changesets', head: plan.head, items: plan.items }),
    );
    await timed('project.store', () =>
      Promise.all([
        putRaw(env, (id) => objects.rawKey(id), built.raw),
        objects.cache(built.objects, 'edge'),
      ]),
    );
    try {
      await projector.call({
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
