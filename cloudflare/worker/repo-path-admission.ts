// Repository discovery and authority admission share one uniform path refusal.
import { ApiError, type Credentials, caller } from './repo-ops';
import type { SnapshotRequest } from './repo-overview-admission';
import type { Env } from './types';

export const missingPath = () => new ApiError('NOT_FOUND', 'No such repository');

/** Refuses private and unknown discovery rows before waking repository objects.
 * Listing can lag toward private; the authority still decides every admitted read. */
export async function admitAnonymous(env: Env, repo: string) {
  const row = await env.INDEX.prepare('SELECT visibility FROM platform_repos WHERE id=?')
    .bind(repo)
    .first<{ visibility: string }>();
  if (row?.visibility !== 'public') throw new ApiError('NOT_FOUND', 'Repository not found');
}

/** Fresh authority status for a path, with indistinguishable missing/private refusals. */
export async function readableRepository(
  env: Env,
  auth: Credentials | null,
  repo: string,
  snapshot?: SnapshotRequest,
) {
  try {
    if (!auth) await admitAnonymous(env, repo);
    return await caller(
      env,
      repo,
      auth ?? { _anonymous: true },
    )({ op: 'repo_status', ...(snapshot && { snapshot }) });
  } catch (e: any) {
    if (['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED', 'GONE'].includes(e?.code)) throw missingPath();
    throw e;
  }
}
