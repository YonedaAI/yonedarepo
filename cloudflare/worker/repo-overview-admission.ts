// An authority-selected snapshot travels only within this freshly admitted Overview.
import type { RepoSnapshot } from '../../shared/contracts/repo-status';
import { type Json, SHA } from './repo-ops';
import { overviewRequested } from './repo-overview';
import type { Env } from './types';

export type SnapshotRequest = { ref: string; min_version: number };

/** Only a current ordinary Overview may ask; historical/commit readers keep their path. */
export function overviewSnapshotRequest(
  env: Env,
  query?: URLSearchParams,
): SnapshotRequest | undefined {
  if (
    env.OVERVIEW_ADMITTED_SNAPSHOT !== 'on' ||
    env.OVERVIEW_DEFER_ACTIVITY !== 'on' ||
    !overviewRequested(env, query) ||
    !query ||
    query.has('at') ||
    query.has('commit') ||
    SHA.test(query.get('ref') ?? '')
  )
    return undefined;
  const minimum = Number(query.get('min_version') ?? 0);
  return Number.isSafeInteger(minimum) && minimum >= 0
    ? { ref: query.get('ref') || 'main', min_version: minimum }
    : undefined;
}

/** Data comes only from repo_status, never a user tree/query marker. */
export function admittedOverviewSnapshot(
  env: Env,
  status: Json,
  query: URLSearchParams,
): RepoSnapshot | undefined {
  const requested = overviewSnapshotRequest(env, query);
  const selected = status.snapshot;
  // Match rows::branch_ref's short/full spelling; Rust remains the syntax validator.
  const ref = requested?.ref.startsWith('refs/') ? requested.ref : `refs/heads/${requested?.ref}`;
  if (
    !requested ||
    status.parent != null ||
    status.grant != null ||
    !Number.isSafeInteger(status.version) ||
    requested.min_version > status.version ||
    selected?.version !== status.version ||
    selected?.ref !== ref ||
    typeof selected?.commit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(selected.commit) ||
    typeof selected?.tree !== 'string' ||
    !/^[0-9a-f]{40}$/.test(selected.tree)
  )
    return undefined;
  return selected as RepoSnapshot;
}
