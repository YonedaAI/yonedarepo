import { type SourceRevision, sourceError } from './source-contract';
import { compareSourcePaths, sourceOid, sourcePath } from './source-path';
import { refreshRevision } from './source-refresh-git';
import { ledger } from './storage';
import type { Env, Scope } from './types';

type FrozenRevision = { repository: string; commit: string; tree?: string };
export type RefreshPathsRef = { version: 1; id: string; digest: string; count: number };
export type RefreshFrozen = {
  version: 1;
  job_id: string;
  epoch: number;
  conflict_id: string;
  base: FrozenRevision;
  head: FrozenRevision;
  candidate: FrozenRevision;
  declared_paths?: string[] | null;
  declared_paths_ref?: RefreshPathsRef | null;
  declared_paths_count?: number;
  expected_version: number;
};
export type RefreshContext = {
  version: 1;
  base: SourceRevision;
  head: SourceRevision;
  candidate: SourceRevision;
  candidateParents: string[];
  declaredPaths?: string[];
  declaredPathsRef?: RefreshPathsRef;
  targetVersion: number;
  source_capture_ref: { branch: string; expected_head: string };
};

/** The native command checks current target/policy/lease before any SDK or R2 access. */
export async function sourceRefreshFrozen(env: Env, scope: Scope): Promise<RefreshFrozen> {
  if (
    scope.job.kind !== 'capture' ||
    scope.job.payload?.capture_subtype !== 'refresh_candidate' ||
    scope.job.payload?.workspace_transport !== 'api-source-v1'
  )
    throw sourceError('FORBIDDEN', 'No sparse refresh capture capability');
  const frozen = (await ledger(env, scope.repo_id, {
    op: 'source_refresh_context',
    job_id: scope.job.id,
    epoch: scope.job.epoch,
  })) as RefreshFrozen;
  if (
    frozen.version !== 1 ||
    frozen.job_id !== scope.job.id ||
    frozen.epoch !== scope.job.epoch ||
    !Number.isSafeInteger(frozen.expected_version) ||
    frozen.expected_version < 0
  )
    throw sourceError('SOURCE_SCOPE', 'Refresh identity or target version differs');
  const reference = frozen.declared_paths_ref;
  if (reference != null) {
    if (
      Object.keys(reference).length !== 4 ||
      reference.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(reference.digest) ||
      reference.id !== `paths:${reference.digest}` ||
      !Number.isSafeInteger(reference.count) ||
      reference.count < 0 ||
      reference.count > 20000 ||
      (frozen.declared_paths_count !== undefined && frozen.declared_paths_count !== reference.count)
    )
      throw sourceError('SOURCE_SCOPE', 'Native refresh path reference differs');
    // A compact reference is the authority, even if an older adapter included an empty array.
    return { ...frozen, declared_paths: null };
  }
  if (!Array.isArray(frozen.declared_paths))
    throw sourceError('SOURCE_SCOPE', 'Refresh declared paths are missing');
  if (frozen.declared_paths.length > 20000)
    throw sourceError('SOURCE_LIMIT', 'Refresh declared paths exceed allowance');
  const paths = frozen.declared_paths.map((path) => {
    if (typeof path !== 'string') throw sourceError('SOURCE_PATH', 'Invalid refresh path');
    sourcePath(path.endsWith('/') ? path.slice(0, -1) : path);
    return path;
  });
  if (new Set(paths).size !== paths.length)
    throw sourceError('SOURCE_SCOPE', 'Refresh paths are ambiguous');
  return { ...frozen, declared_paths: paths.sort(compareSourcePaths) };
}

export async function sourceRefreshContext(env: Env, scope: Scope, frozen?: RefreshFrozen) {
  const value = frozen ?? (await sourceRefreshFrozen(env, scope));
  const base = await refreshRevision(env, value.base);
  const head = await refreshRevision(env, value.head);
  const candidate = await refreshRevision(env, value.candidate);
  if (
    (value.candidate.tree !== undefined && value.candidate.tree !== candidate.revision.tree) ||
    candidate.parents.length < 1 ||
    candidate.parents.length > 2 ||
    candidate.parents[0] !== base.revision.commit ||
    new Set(candidate.parents).size !== candidate.parents.length ||
    head.revision.commit === candidate.revision.commit
  )
    throw sourceError('SOURCE_CHANGED', 'Frozen candidate parent or tree differs');
  const assigned = scope.job.source_capture_ref;
  if (!assigned || typeof assigned.branch !== 'string')
    throw sourceError('SOURCE_SCOPE', 'Refresh fork branch is not assigned');
  sourceOid(assigned.expected_head);
  return {
    version: 1,
    base: base.revision,
    head: head.revision,
    candidate: candidate.revision,
    candidateParents: candidate.parents,
    ...(value.declared_paths_ref
      ? { declaredPathsRef: value.declared_paths_ref }
      : { declaredPaths: value.declared_paths ?? [] }),
    targetVersion: value.expected_version,
    source_capture_ref: { branch: assigned.branch, expected_head: assigned.expected_head },
  } satisfies RefreshContext;
}
