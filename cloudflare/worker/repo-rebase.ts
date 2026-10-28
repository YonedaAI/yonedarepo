// Server-side rebase. The authority plans which commits of a working branch to replay
// (`repo_rebase_plan`); each one is three-way merged onto the new head in stateless
// compute and committed (moving no ref), then the branch moves with one compare-and-swap
// on the planned head. A conflict fails the whole rebase and leaves the branch unchanged;
// commits made before it stay unlanded, and vacuum releases them once they expire.
import { commit } from './repo-commit';
import { notifyHooks } from './repo-hooks';
import { mergeTrees, scopedConflict } from './repo-merge';
import type { Json, RepoContext } from './repo-ops';

const PLATFORM_AUTHOR = { name: 'YonedaRepo', email: 'commits@yonedarepo.invalid' };

/** `git rebase <onto> <branch>` on the server (`onto` defaults to main). */
export async function rebase(ctx: RepoContext, args: Json) {
  const plan = await ctx.call({
    op: 'repo_rebase_plan',
    ref: args.branch,
    onto: args.onto ?? 'main',
  });
  const answer = { ref: plan.ref, onto: plan.onto, before: plan.head };
  if (plan.up_to_date) return { ...answer, up_to_date: true, head: plan.head };
  const objects = await ctx.objects();
  let head = { commit: plan.onto_head as string, tree: plan.onto_tree as string };
  const commits: Json[] = [];
  for (const item of plan.commits as Json[]) {
    const merged = await mergeTrees(objects, {
      base: item.parent_tree,
      ours: head.tree,
      theirs: item.tree,
    });
    if (merged.conflicts.length > 0) {
      const refused = await scopedConflict(ctx, merged.conflicts);
      if (refused.details) refused.details.commit = item.commit;
      throw refused;
    }
    // Already on the new base (applied upstream): dropped, as `git rebase` drops it.
    if (merged.changes.length === 0) continue;
    // A lost check-run message leaves the runs queued; it does not fail the rebase midway.
    const made = await commit(
      ctx,
      objects,
      {
        parent: head.commit,
        base_version: plan.version,
        changes: merged.changes,
        message: item.message,
        author: args.author ?? PLATFORM_AUTHOR,
      },
      'best_effort',
    );
    head = { commit: made.commit, tree: made.tree };
    commits.push({ from: item.commit, to: made.commit });
  }
  const moved = await ctx.call({
    op: 'repo_branch_set',
    ref: plan.ref,
    commit: head.commit,
    expected: plan.head,
  });
  await notifyHooks(ctx.env, ctx.repo);
  return { ...answer, head: head.commit, version: moved.version, commits };
}
