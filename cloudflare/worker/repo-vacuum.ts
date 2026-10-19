// Vacuum: releases hidden refs of commits that are covered by a projected branch or whose
// unlanded work expired, so the object store's own GC may reclaim them. The authority
// decides what is safe; the adapter only sends the ref deletions and reports back.
import { compute } from './repo-compute';
import { fromBase64, toBase64 } from './repo-objects';
import type { Json, RepoContext } from './repo-ops';

export async function vacuum(ctx: RepoContext, args: Json) {
  const plan = await ctx.call({
    op: 'repo_vacuum_plan',
    ...(args.retention_ms ? { retention_ms: Number(args.retention_ms) } : {}),
  });
  const objects = await ctx.objects();
  const released: string[] = [];
  const failed: Json[] = [];
  for (const commit of [...plan.covered, ...plan.expired] as string[]) {
    const request = compute({ op: 'ref_delete', commit });
    const report = await objects.push(fromBase64(request.push_b64));
    const outcome = compute({
      op: 'push_outcome',
      refname: request.refname,
      report_b64: toBase64(report),
    });
    if (outcome.accepted) released.push(commit);
    else failed.push({ commit, refused: outcome.refused });
  }
  if (released.length > 0) await ctx.call({ op: 'repo_vacuum_done', commits: released });
  return {
    covered: plan.covered.length,
    expired: plan.expired.length,
    released: released.length,
    failed,
  };
}
