// Stateless commit creation (Scion): the authority only authorizes the write and names
// the parent; the commit is built in this Worker by Rust compute and recorded with its
// staged objects in its commit shard. Nothing is written to the authority, which adopts
// the commit when it first needs it. Merges, replays of known blobs and commits too large
// to stage keep the authority's prepare path.
import { deferred } from './background';
import { dispatchRuns } from './repo-checks';
import { reviewClasses, symbolWrites } from './repo-code';
import { compute } from './repo-compute';
import { beginFromHead } from './repo-head';
import type { CachedObject, RepoObjects, TreeEntry } from './repo-objects';
import { caller, type Json, type RepoContext } from './repo-ops';
import { dispatchObjects } from './repo-projection';
import { shardCall, shardOf, shardRecord } from './repo-shards';
import { timed } from './repo-timing';

const STAGE_OBJECTS = 256;
const STAGE_BYTES = 1024 * 1024;

/** Whether `body` can be built statelessly here. */
export const shardable = (env: { COMMIT_SHARDS?: unknown }, body: Json) =>
  !!env.COMMIT_SHARDS &&
  !body.merge_parent &&
  !body.merge_parents?.length &&
  Array.isArray(body.changes) &&
  body.changes.every((c: Json) => c?.blob === undefined);

/** Builds and records `body` in its shard; null when it is too large to stage. */
export async function commitInShard(
  ctx: RepoContext,
  given: RepoObjects | null,
  body: Json,
  dispatch: 'required' | 'best_effort',
) {
  // On main, a commit may begin from the published head: no authority call (landing
  // re-checks access and validates the base against the log).
  const onMain = !body.parent && ['main', 'refs/heads/main'].includes(body.ref);
  const paths = body.changes.map((c: Json) => c?.path);
  const begun =
    body.begin_from_head === true && onMain
      ? await timed('begin.head', () => beginFromHead(ctx, paths))
      : await ctx.call({
          op: 'repo_begin_commit',
          ...(body.parent
            ? { parent: body.parent, base_version: body.base_version ?? 0 }
            : body.ref
              ? { ref: body.ref }
              : { parent: null, base_version: body.base_version ?? 0 }),
          paths: body.changes.map((c: Json) => c?.path),
        });
  const store = given ?? ctx.adopt(begun.object_store);
  let parent = begun.parent;
  if (begun.parent_elsewhere) {
    const record = await shardRecord(ctx.env, ctx.repo, begun.parent_id);
    if (!record)
      throw Object.assign(new Error(`Commit ${begun.parent_id} is not recorded`), {
        code: 'NOT_FOUND',
      });
    parent = {
      id: record.commit.id,
      tree: record.commit.tree,
      generation: record.commit.generation,
    };
  }
  const trees: Record<string, TreeEntry[]> = {};
  let built: Json | null = null;
  for (let round = 0; round < 64 && !built; round++) {
    const step = compute({
      op: 'build_commit',
      now: Date.now(),
      parent,
      changes: body.changes,
      message: body.message,
      author: body.author,
      read_set: body.read_set ?? [],
      trees,
    });
    if (!step.need_trees) built = step;
    else
      await timed('trees', () =>
        Promise.all(
          (step.need_trees as string[]).map(async (id) => {
            trees[id] = await store.tree(id);
          }),
        ),
      );
  }
  if (!built)
    throw Object.assign(new Error('Paths are nested too deeply'), { code: 'INVALID_INPUT' });
  const raw = built.raw as Json[];
  const bytes = raw.reduce((n, o) => n + (o.data_b64.length * 3) / 4, 0);
  if (raw.length > STAGE_OBJECTS || bytes > STAGE_BYTES) return null;
  const all = built.objects as CachedObject[];
  // Edge copies spare this colo's first reads a trip down the tiers; they are written after
  // the answer when the request allows it (they share its six connection slots).
  const cacheEdge = () => timed('cache', () => store.cache(all, 'edge'));
  const edge = deferred(cacheEdge) ? Promise.resolve() : cacheEdge();
  const [classes, symbols] = await timed('derive', () =>
    Promise.all([
      // Review classes gate semantic auto-approval; a failure leaves the commit
      // unclassified (a human must approve), never classified as safe.
      reviewClasses(ctx, built.commit, built.touches, all).catch(() => null),
      // Symbol writes narrow what this commit invalidates at landing.
      symbolWrites(ctx, built.commit, built.touches, all).catch(() => null),
    ]),
  );
  const shard = shardOf(built.commit);
  const [recorded] = await Promise.all([
    timed('shard.record', () =>
      shardCall(ctx.env, ctx.repo, shard, {
        op: 'store_record',
        commit: built.commit,
        tree: built.tree,
        parents: built.parents,
        generation: built.generation,
        base_version: begun.base_version,
        principal: begun.principal,
        message: body.message,
        read_set: built.read_set,
        touches: built.touches,
        objects: raw,
        classes: classes && { overall: classes.overall, files: classes.files },
        symbols: symbols?.touches ?? [],
      }),
    ),
    edge,
  ]);
  // Platform checks start on every recorded commit: with runners, the authority adopts it
  // now to queue them.
  let checkRuns: Json[] = [];
  let undispatched = false;
  if (begun.runners) {
    const adopted = await caller(ctx.env, ctx.repo, { _system: 'commits' })({
      op: 'repo_adopt_commit',
      record: await shardRecord(ctx.env, ctx.repo, built.commit),
    });
    checkRuns = adopted.check_runs ?? [];
    try {
      await timed('dispatch', () => dispatchRuns(ctx.env, ctx.repo, checkRuns));
    } catch (e) {
      if (dispatch === 'required') throw e;
      undispatched = true;
    }
  }
  // The commit is durable; its drain request can leave after the answer.
  const send = () => dispatchObjects(ctx.env, ctx.repo, shard);
  const unprojected =
    recorded.dispatch_objects &&
    !deferred(send) &&
    (await timed('dispatch', send).then(
      () => false,
      () => true,
    ));
  return {
    commit: built.commit,
    tree: built.tree,
    parents: built.parents,
    touches: built.touches,
    base_version: begun.base_version,
    check_runs: checkRuns,
    ...(undispatched ? { check_runs_undispatched: true } : {}),
    staged: true,
    ...(unprojected ? { projection_undispatched: true } : {}),
  };
}
