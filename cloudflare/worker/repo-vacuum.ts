// Vacuum: releases hidden refs of commits that are covered by a projected branch or whose
// unlanded work expired, so the object store's own GC may reclaim them. The authority
// decides what is safe; the adapter only sends the ref deletions and reports back. Commit
// shards forget expired commits that nothing newer descends from; branches and pins only
// ever name commits the authority adopted (with all their ancestors), so they keep theirs.
import { compute } from './repo-compute';
import { fromBase64, toBase64 } from './repo-objects';
import type { Json, RepoContext } from './repo-ops';
import { SHARDS, shardCall, shardOf } from './repo-shards';

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
    shards: await vacuumShards(ctx, Number(args.retention_ms ?? DEFAULT_RETENTION_MS)),
  };
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Old shard commits that no newer commit (in any shard) descends from. */
export function expiredCommits(scans: Json[]) {
  const old = new Map<string, string[]>();
  const keep = new Set<string>();
  for (const scan of scans) {
    for (const c of scan.old as Json[]) old.set(c.id, c.parents);
    for (const p of scan.young_parents as string[]) keep.add(p);
  }
  // Every ancestor of a kept commit is kept, across shards.
  const frontier = [...keep];
  while (frontier.length > 0) {
    for (const parent of old.get(frontier.pop() as string) ?? [])
      if (!keep.has(parent)) {
        keep.add(parent);
        frontier.push(parent);
      }
  }
  return [...old.keys()].filter((id) => !keep.has(id));
}

/** Forgets shard commits older than `retention` that no newer commit descends from. */
async function vacuumShards(ctx: RepoContext, retention: number) {
  if (!ctx.env.COMMIT_SHARDS) return { expired: 0, forgotten: 0 };
  const before = Date.now() - Math.max(retention, 60_000);
  const scans = await Promise.all(
    Array.from({ length: SHARDS }, (_, shard) =>
      shardCall(ctx.env, ctx.repo, shard, { op: 'store_vacuum_scan', before }),
    ),
  );
  const expired = expiredCommits(scans);
  const byShard = new Map<number, string[]>();
  for (const id of expired) byShard.set(shardOf(id), [...(byShard.get(shardOf(id)) ?? []), id]);
  const deleted = await Promise.all(
    [...byShard].map(([shard, ids]) =>
      shardCall(ctx.env, ctx.repo, shard, { op: 'store_vacuum_delete', ids }),
    ),
  );
  return { expired: expired.length, forgotten: deleted.reduce((n, d) => n + d.deleted, 0) };
}
