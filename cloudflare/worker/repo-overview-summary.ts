// A browser's fresh summary excludes storage diagnostics and may include Overview.
import type { Json, RepoContext } from './repo-ops';
import { overview, overviewRequested } from './repo-overview';
import { admittedOverviewSnapshot, overviewSnapshotRequest } from './repo-overview-admission';
import { withPath } from './repo-paths';

export async function browserSummary(ctx: RepoContext, query: URLSearchParams): Promise<Json> {
  const requested = overviewSnapshotRequest(ctx.env, query);
  const status = requested
    ? await ctx.call({ op: 'repo_status', snapshot: requested })
    : await ctx.status();
  const admitted = admittedOverviewSnapshot(ctx.env, status, query);
  const { objects: _objects, snapshot: _snapshot, ...summary } = status;
  const decorated = await withPath(ctx.env, ctx.repo, summary);
  return overviewRequested(ctx.env, query)
    ? { ...decorated, overview: await overview(ctx, summary, query, admitted) }
    : decorated;
}
