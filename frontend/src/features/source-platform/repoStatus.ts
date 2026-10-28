// `GET /repos/:id`: the repository's name, log version, policy, refs and the caller's access.
import type { Policy } from '../repo-settings/policy';
import type { Viewer } from './RepoMembers';
import type { Visibility } from './repoAccess';

export type RepoStatus = {
  name: string;
  version: number;
  owner?: string;
  policy: Policy;
  policy_digest?: string;
  refs?: { name: string; commit_id: string; version: number }[];
  projections?: { refname: string; status: string; detail?: string }[];
  viewer?: Viewer;
  /** Who may read: members only, or anyone (absent from an older server: private). */
  visibility?: Visibility;
  /** Set on a fork: the repository it was forked from and that one's version at the fork. */
  parent?: { repo: string; version: number } | null;
  /** How many forks read this repository's objects (it is deleted only after them). */
  forks?: number;
};

/** Whether the viewer may create and delete branches and create tags: the write role and
 * above (the server decides each request; this only hides controls). */
export const canMoveBranches = (viewer: Viewer | undefined) =>
  Boolean(
    viewer && !viewer.public && (viewer.owner || (viewer.role !== null && viewer.role !== 'read')),
  );

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
