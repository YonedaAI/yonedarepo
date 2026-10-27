import type { Snapshot } from '../../lib/types';
import { type InitialRun, workingContinuation } from './restartRun';
import { runDraft } from './runDraft';
import type { WorkingBranch } from './workingBranchView';

export function workingRun(
  snapshot: Snapshot,
  branch: WorkingBranch,
  source?: Record<string, any>,
): InitialRun {
  if (source) return workingContinuation(snapshot, source, branch);
  const draft = runDraft(snapshot);
  return {
    id: '',
    intent: '',
    criteria: draft.criteria.split('\n'),
    context: draft.context,
    agents: draft.agents,
    policy: draft.policy,
    budgets: draft.budgets,
    mode: draft.mode,
    team: draft.previousTeamPlan,
    workingBranch: branch,
  };
}
