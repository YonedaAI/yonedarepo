// Status path decoration: one local projection read, with the legacy home-cell alias
// fallback. The already-authorized repository status still owns its current name.
import { cellOfRepo, cellsOn, FIRST_CELL, indexOf, thisCell } from './cells';
import { repoAnalytics } from './repo-usage';
import type { Env, Json } from './types';

/** Exactly the owner/handle lookup used by status, combined without caching either. */
export async function joinedPathHandle(env: Env, repo: string): Promise<string | null> {
  const row = await env.INDEX.prepare(
    `SELECT r.workspace,h.handle FROM platform_repos AS r
     LEFT JOIN platform_handles AS h ON h.workspace=r.workspace WHERE r.id=?`,
  )
    .bind(repo)
    .first<{ workspace: string; handle: string | null }>();
  if (!row) return null;
  if (!row.workspace.includes('@')) return row.workspace;
  if (row.handle !== null) return row.handle;
  // Email-named accounts predate cells. Their alias may exist only in the first cell,
  // even when this repository is elsewhere; preserve the existing fallback ordering.
  if (cellsOn(env) && thisCell(env) !== FIRST_CELL)
    return (
      (
        await indexOf(env, FIRST_CELL)
          .prepare('SELECT handle FROM platform_handles WHERE workspace=?')
          .bind(row.workspace)
          .first<{ handle: string }>()
      )?.handle ?? null
    );
  return null;
}

/** Decorates an authorized status using a handle its caller already resolved. */
export function statusWithHandle(
  env: Env,
  repo: string,
  status: Json,
  handle: string | null,
): Json {
  const named = {
    ...status,
    owner_handle: handle,
    path: handle ? `/${handle}/${status.name}` : null,
    ...(cellsOn(env) && { region: cellOfRepo(repo) }),
  };
  return repoAnalytics(env) ? { ...named, insights: true } : named;
}
