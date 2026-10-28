// `GET /repos/:id`: the repository's name, log version, policy, refs and the caller's access.
// The type is generated from the Rust status (shared/contracts, `cargo xtask contracts`).
import type { Policy } from '../repo-settings/policy';
import type { Viewer } from './RepoMembers';

export type { RepoStatus } from '../../../../shared/contracts/repo-status';

/** Whether the viewer may create and delete branches and create tags: the write role and
 * above (the server decides each request; this only hides controls). */
export const canMoveBranches = (viewer: Viewer | undefined) =>
  Boolean(viewer && (viewer.owner || (viewer.role !== null && viewer.role !== 'read')));

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What landing on main needs, in words: approvals, auto-approved classes and checks. */
export function landingNeeds(policy: Policy): string[] {
  const needs: string[] = [];
  if (policy.approvals > 0) needs.push(plural(policy.approvals, 'approval'));
  if (policy.approvals > 0 && policy.auto_approve?.length)
    needs.push(`auto-approves ${policy.auto_approve.join(', ').replace(/_/g, ' ')}`);
  for (const check of policy.required_checks) {
    const runner = policy.runners?.[check];
    needs.push(`${runner?.kind === 'model' ? 'AI check' : 'check'} ${check}`);
  }
  return needs;
}
