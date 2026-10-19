// Server-side merges. Landing work whose branch moved asks the authority for a merge
// plan, has Rust compute merge trees and blobs, records a platform merge commit and lands
// it with the authority's verification. Conflicts come back with diff3-marked text.

import { compute } from './repo-compute';
import { fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import { ApiError, caller, commit, type Json, RepoContext } from './repo-ops';

const PLATFORM_AUTHOR = { name: 'YonedaRepo', email: 'commits@yonedarepo.invalid' };
const SHA = /^[0-9a-f]{40}$/;

/** Rust three-way merge of `theirs` into `ours`, supplying trees and blobs on request. */
export async function mergeTrees(objects: RepoObjects, input: Json) {
  const trees: Json = {};
  const blobs: Json = {};
  for (let round = 0; round <= 128; round++) {
    const result = compute({ op: 'merge_trees', ...input, trees, blobs });
    if (result.need_trees)
      await Promise.all(
        (result.need_trees as string[]).map(async (id) => (trees[id] = await objects.tree(id))),
      );
    else if (result.need_blobs)
      await Promise.all(
        (result.need_blobs as string[]).map(
          async (id) => (blobs[id] = toBase64(await objects.blob(id))),
        ),
      );
    else return result as { changes: Json[]; conflicts: Json[] };
  }
  throw new ApiError('INVALID_INPUT', 'Merge did not converge');
}

function conflictError(conflicts: Json[]) {
  const details = conflicts.map((c) => ({
    path: c.path,
    kind: c.kind,
    ...(c.marked_b64 ? { marked: new TextDecoder().decode(fromBase64(c.marked_b64)) } : {}),
    ...(c.regions ? { regions: c.regions } : {}),
  }));
  return new ApiError(
    'CONFLICT',
    `Three-way merge conflicts on ${details.map((d) => `${d.path} (${d.kind})`).join(', ')}`,
    { conflicts: details },
  );
}

/** Lands `sha` on `ref`, creating and landing a platform merge commit if the ref moved. */
export async function landWithMerge(ctx: RepoContext, ref: string, sha: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await ctx.call({ op: 'repo_land', ref, commit: sha });
    } catch (e: any) {
      if (e?.code !== 'MERGE_REQUIRED') throw e;
    }
    const plan = await ctx.call({ op: 'repo_merge_plan', ref, commit: sha });
    if (!['rebase', 'merge'].includes(plan.outcome)) continue;
    const objects = await ctx.objects();
    const merged = await mergeTrees(objects, {
      base: plan.base_tree,
      ours: plan.head_tree,
      theirs: plan.commit_tree,
    });
    if (merged.conflicts.length > 0) throw conflictError(merged.conflicts);
    const merger = new RepoContext(
      ctx.env,
      ctx.repo,
      caller(ctx.env, ctx.repo, { _system: 'merge' }),
    );
    const made = await commit(merger, objects, {
      parent: plan.head,
      merge_parent: sha,
      base_version: plan.version,
      changes: merged.changes,
      message: `Merge ${sha.slice(0, 10)} into ${String(plan.ref).replace(/^refs\/heads\//, '')}`,
      author: PLATFORM_AUTHOR,
    });
    try {
      return {
        ...(await ctx.call({ op: 'repo_land', ref, commit: sha, merge: made.commit })),
        merge: made.commit,
      };
    } catch (e: any) {
      // The head moved again while merging: plan afresh.
      if (e?.code !== 'STALE_PARENT') throw e;
    }
  }
  throw new ApiError('CONFLICT', `${ref} kept moving; retry the landing`);
}

/** `git merge <source>` into branch `into`: creates (does not land) a merge commit. */
export async function explicitMerge(ctx: RepoContext, args: Json) {
  const into = String(args.into ?? 'main');
  const head = await ctx.call({ op: 'repo_snapshot', ref: into });
  const source = SHA.test(args.source ?? '')
    ? await ctx.call({ op: 'repo_commit', commit: args.source })
    : await ctx
        .call({ op: 'repo_snapshot', ref: args.source })
        .then((s) => ctx.call({ op: 'repo_commit', commit: s.commit }));
  const { merge_bases } = await ctx.call({
    op: 'repo_merge_base',
    left: head.commit,
    right: source.commit,
  });
  const base = merge_bases[0];
  if (base?.commit === source.commit) return { up_to_date: true, head: head.commit };
  if (base?.commit === head.commit) return { fast_forward: source.commit, head: head.commit };
  const objects = await ctx.objects();
  const merged = await mergeTrees(objects, {
    base: base?.tree ?? null,
    ours: head.tree,
    theirs: source.tree,
  });
  if (merged.conflicts.length > 0) throw conflictError(merged.conflicts);
  return commit(ctx, objects, {
    parent: head.commit,
    merge_parent: source.commit,
    base_version: head.version,
    changes: merged.changes,
    message: args.message ?? `Merge ${args.source} into ${into}`,
    author: args.author ?? PLATFORM_AUTHOR,
  });
}
