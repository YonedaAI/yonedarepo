// Work plans (paper §3.3): proposed work items with read and write sets are planned at
// one revision of a branch. Rust compute joins items that share a written reference
// cycle and stages the rest by Eq. 1; the authority reports items whose reads went stale
// since their base. The platform plans; it never runs the work.

import { withObjects } from './repo-derived';
import { grantOf, keepAllowed } from './repo-grants';
import { ApiError, type Json, type RepoContext, target, withTrees } from './repo-ops';

export async function plan(ctx: RepoContext, args: Json) {
  if (!Array.isArray(args.items) || args.items.length === 0)
    throw new ApiError('INVALID_INPUT', 'items must be a non-empty list');
  const ref = String(args.ref ?? 'main');
  const where = await target(ctx, ref, args.at);
  const objects = await ctx.objects();
  const { changes } = await withTrees(objects, { op: 'tree_diff', old: null, new: where.tree });
  const files = (await keepAllowed(ctx, changes as Json[]))
    .filter((c) => ['blob', 'exec'].includes(c.new?.type))
    .map((c) => ({ path: c.path, id: c.new.id }));
  const planned = await withObjects(ctx, {
    op: 'work_plan',
    items: args.items,
    files,
    grant: await grantOf(ctx),
    ...(args.closure_depth === undefined ? {} : { closure_depth: Number(args.closure_depth) }),
  });
  const { stale } = await ctx.call({
    op: 'repo_stale_reads',
    ref,
    at: where.version,
    items: args.items,
  });
  return { ref, commit: where.commit, version: where.version, ...planned, stale };
}
