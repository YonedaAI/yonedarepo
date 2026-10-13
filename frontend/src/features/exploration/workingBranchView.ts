import type { Snapshot } from '../../lib/types';

export interface WorkingBranch {
  id: string;
  status: string;
  version: number;
  working_commit: string;
  working_revision: { repository: string; commit: string };
  canonical_base_commit: string;
  canonical_base_version?: number;
  latest_candidate_id: string | null;
}
type BranchSnapshot = Snapshot & {
  working_branches?: unknown[];
  capabilities?: Snapshot['capabilities'] & { working_branches?: number };
};
export function supportsWorkingBranches(snapshot: Snapshot) {
  const value = snapshot as BranchSnapshot;
  return (
    (Array.isArray(value.working_branches) && value.working_branches.length > 0) ||
    value.capabilities?.working_branches === 1
  );
}
export function workingBranches(snapshot: Snapshot): WorkingBranch[] {
  const values = (snapshot as BranchSnapshot).working_branches;
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is WorkingBranch => {
    if (!value || typeof value !== 'object') return false;
    const branch = value as WorkingBranch;
    return (
      typeof branch.id === 'string' &&
      !!branch.id &&
      typeof branch.status === 'string' &&
      Number.isSafeInteger(branch.version) &&
      branch.version >= 0 &&
      typeof branch.working_commit === 'string' &&
      !!branch.working_commit &&
      branch.working_revision?.commit === branch.working_commit &&
      typeof branch.working_revision.repository === 'string' &&
      typeof branch.canonical_base_commit === 'string' &&
      (branch.latest_candidate_id === null || typeof branch.latest_candidate_id === 'string')
    );
  });
}
export function runWorkingBranch(snapshot: Snapshot, run: Record<string, any>) {
  return workingBranches(snapshot).find((branch) => branch.id === run.working_branch_id);
}
export function branchPublishable(
  snapshot: Snapshot,
  run: Record<string, any>,
  candidate: Record<string, any>,
) {
  const branch = runWorkingBranch(snapshot, run);
  return (
    !!branch &&
    branch.status === 'active' &&
    branch.canonical_base_commit === snapshot.repository.head_commit &&
    branch.canonical_base_version === snapshot.repository.version &&
    branch.latest_candidate_id === candidate.id &&
    branch.working_revision.commit === candidate.revision?.commit &&
    branch.working_revision.repository === candidate.revision?.repository
  );
}
export function workingBranchRequest(branch?: WorkingBranch) {
  return branch
    ? {
        working_branch_id: branch.id,
        expected_working_commit: branch.working_commit,
        expected_working_version: branch.version,
      }
    : {};
}
