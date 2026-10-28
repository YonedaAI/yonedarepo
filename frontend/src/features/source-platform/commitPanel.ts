// What a commit page offers, from the commit's landings and gates, the policy and the
// viewer's role: a landed commit only reports where it landed (and may be reverted); one not
// yet landed says what landing needs in plain words and offers only the actions that apply.
// The server decides every request; this only chooses what to show.
import type { Policy } from '../repo-settings/policy';
import type { Gates, Landing, ReviewClasses } from './CommitGates';
import type { Viewer } from './RepoMembers';

const CLASS_LABELS: Record<string, string> = {
  docs: 'Docs-only change',
  formatting: 'Formatting-only change',
  comment_only: 'Comments-only change',
  logic: 'Code change',
  instructions: 'Agent instructions change',
};

/** A plain label for a known review class; null when unclassified or `unknown`. */
export const classLabel = (classes: ReviewClasses) =>
  (classes && CLASS_LABELS[classes.overall]) ?? null;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What landing still needs, in words; empty when the gates are satisfied. */
export function gateNeeds(gates: Gates): string[] {
  const needs: string[] = [];
  if (gates.rejected) needs.push('A reviewer rejected it: it needs a new commit.');
  const missing = gates.approvals_required - gates.approvals;
  if (!gates.auto_approved && missing > 0)
    needs.push(
      `${plural(missing, 'more approval')} (${gates.approvals} of ${gates.approvals_required}).`,
    );
  if (gates.missing_checks.length)
    needs.push(`Waiting for checks: ${gates.missing_checks.join(', ')}.`);
  if (gates.failing_checks.length)
    needs.push(`Failing checks: ${gates.failing_checks.join(', ')}.`);
  return needs;
}

const reviewer = (viewer: Viewer | undefined) =>
  Boolean(viewer && (viewer.owner || viewer.role === 'land' || viewer.role === 'admin'));
const writer = (viewer: Viewer | undefined) =>
  Boolean(viewer && (viewer.owner || (viewer.role !== null && viewer.role !== 'read')));
export const checksConfigured = (policy: Policy | undefined) =>
  Boolean(
    policy && (policy.required_checks.length > 0 || Object.keys(policy.runners ?? {}).length > 0),
  );

export type CommitPanel =
  | { state: 'landed'; landings: Landing[]; revert: boolean; runChecks: boolean }
  | {
      state: 'pending';
      ready: boolean;
      needs: string[];
      review: boolean;
      land: boolean;
      runChecks: boolean;
      breakGlass: boolean;
    };

export function commitPanel(
  commit: { landings: Landing[]; gates: Gates },
  viewer: Viewer | undefined,
  policy: Policy | undefined,
): CommitPanel {
  const runChecks = writer(viewer) && checksConfigured(policy);
  if (commit.landings.length > 0)
    return { state: 'landed', landings: commit.landings, revert: writer(viewer), runChecks };
  const { gates } = commit;
  const needs = gateNeeds(gates);
  return {
    state: 'pending',
    ready: gates.ready,
    needs,
    review: reviewer(viewer) && gates.approvals_required > 0 && !gates.auto_approved,
    land: reviewer(viewer) && gates.ready,
    runChecks,
    breakGlass: Boolean(viewer?.owner) && !gates.ready,
  };
}

/** The branch a revert goes on: main when the commit landed there, else its first landing. */
export const revertBranch = (landings: Landing[]) =>
  (landings.find((l) => l.refname === 'refs/heads/main') ?? landings[0]).refname.replace(
    /^refs\/heads\//,
    '',
  );
