// The platform's write path: server-side commits (prepare, then accept: staged in the
// authority or pushed to the object store) and the revert/cherry-pick replays built on
// them. Reads and the authority caller live in repo-ops.
import { afterAnswer } from './background';
import { dispatchRuns } from './repo-checks';
import { reviewClasses, symbolWrites } from './repo-code';
import { commitInShard, shardable } from './repo-commit-shard';
import { pushCommit } from './repo-object-push';
import {
  type CachedObject,
  fromBase64,
  OVERLAP_CACHE_OBJECTS,
  type RepoObjects,
  type TreeEntry,
  toBase64,
} from './repo-objects';
import { ApiError, batch, caller, type Json, type RepoContext, withTrees } from './repo-ops';
import { dispatchObjects } from './repo-projection';
import { putRaw } from './repo-stores';
import { timed } from './repo-timing';

/** How a commit treats a lost queue: `best_effort` reports undispatched check runs instead
 * of failing (they stay queued in the authority and are re-dispatched on request). */
export type Dispatch = 'required' | 'best_effort';

/**
 * Prepare (answering tree requests), then accept. A small commit is staged: the authority
 * holds its objects durably and records it at once; the projector pushes it to the object
 * store afterwards. A larger one is pushed and read back from the store first. Review
 * classes and symbol writes are computed beforehand and recorded in the same round trip.
 */
export async function commit(
  ctx: RepoContext,
  given: RepoObjects | null,
  body: Json,
  dispatch: Dispatch = 'required',
) {
  if (shardable(ctx.env, body)) {
    const sharded = await commitInShard(ctx, given, body, dispatch);
    if (sharded) return sharded;
  }
  // A branch is resolved by the first prepare round, which pins its head for the rest.
  let base: Json = body.parent
    ? { parent: body.parent, base_version: body.base_version ?? 0 }
    : body.ref
      ? { ref: body.ref }
      : { parent: null, base_version: body.base_version ?? 0 };
  let objects = given;
  const trees: Record<string, TreeEntry[]> = {};
  for (let round = 0; round < 64; round++) {
    const prepared = await ctx.call({
      op: 'repo_prepare_commit',
      ...base,
      changes: body.changes,
      message: body.message,
      author: body.author,
      ...(body.committer ? { committer: body.committer } : {}),
      read_set: body.read_set ?? [],
      ...(body.merge_parent ? { merge_parent: body.merge_parent } : {}),
      ...(body.merge_parents ? { merge_parents: body.merge_parents } : {}),
      trees,
      stage: true,
    });
    objects ??= ctx.adopt(prepared.object_store);
    const store = objects;
    if (prepared.need_trees) {
      base = { parent: prepared.parent, base_version: prepared.base_version };
      await timed('trees', () =>
        Promise.all(
          (prepared.need_trees as string[]).map(async (id) => {
            trees[id] = await store.tree(id);
          }),
        ),
      );
      continue;
    }
    const all = prepared.objects as CachedObject[];
    const derived = timed('derive', () =>
      Promise.all([
        // Review classes gate semantic auto-approval; a failure leaves the commit
        // unclassified (a human must approve), never classified as safe.
        reviewClasses(ctx, prepared.commit, prepared.touches, all).catch(() => null),
        // Symbol writes narrow what this commit invalidates at landing; without them each
        // changed file counts as written in full.
        symbolWrites(ctx, prepared.commit, prepared.touches, all).catch(() => null),
      ]),
    );
    let record: Json;
    let edge: Promise<unknown> = Promise.resolve();
    if (prepared.staged) {
      record = { op: 'repo_record_commit', commit: prepared.commit, staged: true };
      // The edge copy spares the first reads a trip to the authority's staged copy; it is
      // written after the answer (reads fall back to the staged copy meanwhile).
      edge = afterAnswer(() => timed('cache', () => store.cache(all, 'edge')));
    } else {
      // Immutable and keyed by id, so the cache write runs alongside the push. A large
      // import writes through only its commit: thousands of tier writes cost minutes
      // (Workers keep six connections open) and reads fill the tiers from the store anyway.
      const written =
        all.length > OVERLAP_CACHE_OBJECTS ? all.filter((o) => o.id === prepared.commit) : all;
      // The raw commit goes to the store of record too: clients fetch the exact object
      // from there (the store behind the push may keep only its tree and parents).
      const raw = { id: prepared.commit, kind: 'commit' as const, data_b64: prepared.commit_b64 };
      const cached = timed('cache', () =>
        Promise.all([store.cache(written), putRaw(ctx.env, (id) => store.rawKey(id), [raw])]),
      );
      const { report, readback } = await timed('push', () =>
        pushCommit(store, fromBase64(prepared.push_b64), prepared.commit, cached),
      );
      record = {
        op: 'repo_record_commit',
        commit: prepared.commit,
        push_report_b64: toBase64(report),
        readback,
      };
    }
    const deriver = caller(ctx.env, ctx.repo, { _system: 'derive' });
    const extra = (await derived).filter((c): c is Json => c !== null).map(deriver.sign);
    const [[recorded]] = await Promise.all([
      batch(ctx.env, ctx.repo, [ctx.call.sign(record), ...extra]),
      edge,
    ]);
    if (recorded.error) throw new ApiError(recorded.error.code, recorded.error.message);
    let undispatched = false;
    try {
      await timed('dispatch', () => dispatchRuns(ctx.env, ctx.repo, recorded.check_runs));
    } catch (e) {
      if (dispatch === 'required') throw e;
      undispatched = true;
    }
    // The commit is durable either way; a lost message leaves it pending (visible in
    // status) until the next commit or ref projection drains the outbox.
    const unprojected =
      recorded.dispatch_objects &&
      (await timed('dispatch', () => dispatchObjects(ctx.env, ctx.repo)).then(
        () => false,
        () => true,
      ));
    return {
      commit: prepared.commit,
      tree: prepared.tree,
      parents: prepared.parents,
      touches: prepared.touches,
      base_version: prepared.base_version,
      check_runs: recorded.check_runs ?? [],
      ...(undispatched ? { check_runs_undispatched: true } : {}),
      ...(recorded.staged ? { staged: true } : {}),
      ...(unprojected ? { projection_undispatched: true } : {}),
    };
  }
  throw new ApiError('INVALID_INPUT', 'Paths are nested too deeply');
}

const PLATFORM_AUTHOR = { name: 'YonedaRepo', email: 'commits@yonedarepo.invalid' };

/** Server-side revert or cherry-pick of `args.commit` onto branch `args.ref` (default main). */
export async function replay(
  ctx: RepoContext,
  args: Json,
  direction: 'revert' | 'pick',
  dispatch: Dispatch = 'required',
) {
  const source = await ctx.call({ op: 'repo_commit', commit: args.commit });
  const parent = source.parents[0]
    ? await ctx.call({ op: 'repo_commit', commit: source.parents[0] })
    : null;
  const objects = await ctx.objects();
  const { changes } = await withTrees(objects, {
    op: 'replay_changes',
    direction,
    old: parent?.tree ?? null,
    new: source.tree,
  });
  const subject = String(source.message).split('\n')[0];
  const message =
    args.message ??
    (direction === 'revert'
      ? `Revert "${subject}"\n\nThis reverts commit ${source.commit}.`
      : `${source.message}\n\n(cherry picked from commit ${source.commit})`);
  return commit(
    ctx,
    objects,
    {
      ref: args.ref ?? 'main',
      // An explicit parent pins the head the caller decided on.
      ...(args.parent ? { parent: args.parent, base_version: args.base_version } : {}),
      changes,
      message,
      author: args.author ?? PLATFORM_AUTHOR,
      read_set: args.read_set,
    },
    dispatch,
  );
}
