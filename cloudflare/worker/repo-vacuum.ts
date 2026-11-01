// Vacuum: commit shards forget expired commits that nothing newer descends from; branches and
// pins only ever name commits the authority adopted (with all their ancestors), so they keep
// theirs.
import { currentHold } from './platform-legal-hold';
import type { Json, RepoContext } from './repo-ops';
import { SHARDS, shardCall, shardOf } from './repo-shards';

export async function vacuum(ctx: RepoContext, args: Json) {
  // The gate: who may vacuum, and no legal hold.
  await ctx.call({ op: 'repo_vacuum_plan' });
  return { shards: await vacuumShards(ctx, Number(args.retention_ms ?? DEFAULT_RETENTION_MS)) };
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
  // Asked after the scans, just before the deletes.
  const _hold = expired.length ? await currentHold(ctx.env, ctx.repo, ctx.call) : undefined;
  const deleted = await Promise.all(
    [...byShard].map(([shard, ids]) =>
      shardCall(ctx.env, ctx.repo, shard, { op: 'store_vacuum_delete', ids, _hold }),
    ),
  );
  return { expired: expired.length, forgotten: deleted.reduce((n, d) => n + d.deleted, 0) };
}
