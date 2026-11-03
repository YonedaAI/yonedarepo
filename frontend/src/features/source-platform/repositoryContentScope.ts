// A mounted reader may retain image state only within this fresh content/access scope.
import type { RepoStatus } from './repoStatus';

const legacy = new WeakMap<object, number>();
let sequence = 0;
function legacyScope(status: object) {
  let id = legacy.get(status);
  if (id === undefined) {
    id = ++sequence;
    legacy.set(status, id);
  }
  return `legacy:${id}`;
}

/** Missing legacy guards cause a remount on each fresh response, not a byte cache. */
export function repositoryContentScope(status: RepoStatus | undefined): string {
  if (!status) return 'pending';
  const viewer = status.viewer;
  if (
    typeof status.object_store !== 'string' ||
    !status.object_store ||
    typeof status.history_chain !== 'string' ||
    !status.history_chain ||
    !Number.isSafeInteger(status.quarantine_epoch) ||
    status.quarantine_epoch < 0 ||
    !viewer ||
    typeof viewer.principal !== 'string' ||
    !viewer.principal ||
    typeof viewer.owner !== 'boolean' ||
    typeof viewer.public !== 'boolean' ||
    (viewer.role !== null && !['read', 'write', 'land', 'admin'].includes(viewer.role)) ||
    (status.grant !== null &&
      (!Array.isArray(status.grant) || !status.grant.every((p) => typeof p === 'string'))) ||
    (status.visibility !== 'public' && status.visibility !== 'private')
  )
    return legacyScope(status);
  return JSON.stringify([
    status.object_store,
    status.history_chain,
    status.quarantine_epoch,
    status.grant,
    status.visibility,
    viewer.principal,
    viewer.owner,
    viewer.role,
    viewer.public,
  ]);
}

export function repositoryContentKey(
  scope: string,
  place: {
    repo: string;
    ref: string;
    path: string;
    at?: number;
  },
) {
  return JSON.stringify([scope, place.repo, place.ref, place.path, place.at ?? null]);
}
