// Stateless commit creation (Scion): the authority only authorizes the write and names
// the parent; the commit is built in this Worker by Rust compute and recorded with its
// staged objects in its commit shard. Nothing is written to the authority, which adopts
// the commit when it first needs it. Merges, replays of known blobs and commits too large
// to stage keep the authority's prepare path.
import { afterAnswer, deferred } from './background';
import { dispatchRuns } from './repo-checks';
import { reviewClasses, symbolWrites } from './repo-code';
import { compute } from './repo-compute';
import { inBatches } from './repo-git-objects';
import { beginFromHead, headTrees, noteBuilt } from './repo-head';
import type { CachedObject, RepoObjects, TreeEntry } from './repo-objects';
import { caller, type Json, type RepoContext } from './repo-ops';
import { dispatchObjects } from './repo-projection';
import { recordInShard, shardOf, shardRecord } from './repo-shards';
import { timed } from './repo-timing';

const STAGE_OBJECTS = 256;
const STAGE_BYTES = 1024 * 1024;
/** R2 writes in flight in a commit's blob write-through (an invocation keeps six
 * connections open). */
const R2_WRITES = 6;

/** Whether `body` can be built statelessly here. */
export const shardable = (env: { COMMIT_SHARDS?: unknown }, body: Json) =>
  !!env.COMMIT_SHARDS &&
  !body.merge_parent &&
  !body.merge_parents?.length &&
  Array.isArray(body.changes) &&
  body.changes.every((c: Json) => c?.blob === undefined);

/** Builds and records `body` in its shard; null when it is too large to stage or when a
 * secret scan refuses it (the authority applies the policy's allowances and decides). */
export async function commitInShard(
  ctx: RepoContext,
  given: RepoObjects | null,
  body: Json,
  dispatch: 'required' | 'best_effort',
) {
  // On main, a commit may begin from the published head: no authority call and no
  // optimistic-concurrency check until landing, which re-checks access and validates the
  // base against the log.
  const onMain = !body.parent && ['main', 'refs/heads/main'].includes(body.ref);
  const paths = body.changes.map((c: Json) => c?.path);
  const fromHead =
    body.begin_from_head === true && onMain
      ? await timed('begin.head', () => beginFromHead(ctx, paths)).catch((e) => {
          // No main to publish (an empty repository): the authority begins the first commit.
          if (e?.code === 'NOT_FOUND') return null;
          throw e;
        })
      : null;
  const begun =
    fromHead ??
    (await ctx.call({
      op: 'repo_begin_commit',
      ...(body.parent
        ? { parent: body.parent, base_version: body.base_version ?? 0 }
        : body.ref
          ? { ref: body.ref }
          : { parent: null, base_version: body.base_version ?? 0 }),
      paths: body.changes.map((c: Json) => c?.path),
    }));
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
  let asked = false;
  let built: Json | null = null;
  for (let round = 0; round < 64 && !built; round++) {
    let step: Json;
    try {
      step = compute({
        op: 'build_commit',
        now: Date.now(),
        parent,
        changes: body.changes,
        message: body.message,
        author: body.author,
        ...(body.committer ? { committer: body.committer } : {}),
        read_set: body.read_set ?? [],
        trees,
      });
    } catch (e: any) {
      // Only the authority knows the policy's accepted false positives: it decides.
      if (e?.code === 'SECRET_DETECTED') return null;
      throw e;
    }
    // Symlinks by blob id never reach a shard (see `shardable`); the authority reads them.
    if (step.need_blobs) return null;
    if (!step.need_trees) {
      built = step;
      continue;
    }
    // The parent's trees: this isolate's memory, then the head holder (every level along
    // the paths in one call), then the tiers, one level per round.
    const missing = (step.need_trees as string[]).filter((id) => {
      const entries = store.remembered(id);
      if (entries) trees[id] = entries;
      return !entries;
    });
    if (missing.length)
      await timed('trees', async () => {
        if (!asked && parent) {
          asked = true;
          const served = await headTrees(ctx.env, ctx.repo, parent.tree, paths, parent.id);
          if (served) {
            store.remember(served);
            Object.assign(trees, served);
          }
        }
        await Promise.all(
          missing
            .filter((id) => !trees[id])
            .map(async (id) => {
              trees[id] = await store.tree(id, parent?.id);
            }),
        );
      });
  }
  if (!built)
    throw Object.assign(new Error('Paths are nested too deeply'), { code: 'INVALID_INPUT' });
  const raw = built.raw as Json[];
  const bytes = raw.reduce((n, o) => n + (o.data_b64.length * 3) / 4, 0);
  if (raw.length > STAGE_OBJECTS || bytes > STAGE_BYTES) return null;
  noteBuilt(built.commit, paths);
  const all = built.objects as CachedObject[];
  // Edge copies (and this isolate's memory of the trees, which its next commits build on)
  // start now, but the answer does not wait for them: the edge is an optimization, and a
  // slow Cache API put held commits for seconds (commit p95 18.7 s, 10-28).
  const edge = afterAnswer(() => timed('cache', () => store.cache(all, 'edge')));
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
    recordInShard(ctx.env, ctx.repo, shard, {
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
  await writeBlobsThrough(ctx, store, all);
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

/**
 * Writes a commit's blobs to R2's cache key after its own I/O, where any isolate's first
 * read of the file finds them: the shard's drain to R2 waits in the queue behind a burst,
 * and a read that misses R2 asks all 64 shards (hosted burst read-backs, 10-28:
 * `read.shards` up to 4.6 s). Started only now, after the shard record, the check dispatch
 * and the drain request: an R2 put holds one of the invocation's six connections, and
 * R2_WRITES of them beside those calls would queue the commit behind its own cache writes.
 * A failure leaves the blob to the drain and never fails the commit.
 * `BLOB_WRITE_THROUGH=off` leaves every blob to the drain.
 */
function writeBlobsThrough(ctx: RepoContext, store: RepoObjects, all: CachedObject[]) {
  const blobs = all.filter((o) => o.kind === 'blob');
  if (ctx.env.BLOB_WRITE_THROUGH === 'off' || !blobs.length) return;
  return afterAnswer(() =>
    timed('cache.through', () =>
      inBatches(blobs, R2_WRITES, (o) => store.cache([o], 'r2')).catch((e) =>
        console.warn(`blob write-through failed: ${e?.message ?? e}`),
      ),
    ),
  );
}
