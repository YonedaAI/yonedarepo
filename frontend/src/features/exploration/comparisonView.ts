import type { ComparisonState } from '../../lib/comparison';
import type { Snapshot } from '../../lib/types';
import { comparisonSkipNotice } from './comparisonSkipNotice';
import { runHasActiveAttempts } from './runControlState';
import { runWorkingBranch } from './workingBranchView';

export function comparisonState(run: Record<string, any>): ComparisonState | undefined {
  return run.mode === 'compare' && run.comparison?.version === 1 ? run.comparison : undefined;
}
export function comparisonBusy(snapshot: Snapshot, run: Record<string, any>) {
  return (
    runHasActiveAttempts(snapshot, run) ||
    ['building', 'checking', 'reviewing', 'repairing'].includes(comparisonState(run)?.status ?? '')
  );
}
export function comparisonPhase(snapshot: Snapshot, run: Record<string, any>) {
  if (run.status === 'cancelled') return 'Cancelled';
  const state = comparisonState(run);
  const skip = comparisonSkipNotice(state);
  if (skip) return skip.title;
  const labels = {
    building: 'Building',
    checking: 'Checking',
    reviewing: 'Reviewing alternatives',
    repairing: 'Repairing',
    selected: 'Ready to publish',
    needs_attention: 'Needs attention',
    stale: 'Review needs refresh',
  };
  if (state)
    return state.status === 'selected' && comparisonBusy(snapshot, run)
      ? 'Reviewing alternatives'
      : labels[state.status];
  return run.status === 'failed'
    ? 'Failed'
    : runHasActiveAttempts(snapshot, run)
      ? 'Building'
      : 'Manual comparison';
}
export function comparisonLease(snapshot: Snapshot, run: Record<string, any>) {
  const branch = runWorkingBranch(snapshot, run);
  return {
    run_id: run.id,
    expected_commit: snapshot.repository.head_commit,
    expected_version: snapshot.repository.version,
    expected_policy_version: snapshot.repository.policy?.version,
    ...(branch
      ? { expected_working_commit: branch.working_commit, expected_working_version: branch.version }
      : {}),
  };
}

export function comparisonChoiceBlocker(
  snapshot: Snapshot,
  run: Record<string, any>,
  candidate?: Record<string, any>,
  reviewOnly = false,
) {
  if (run.mode !== 'compare' || ['cancelled', 'accepted', 'awaiting_intent'].includes(run.status))
    return 'This run cannot select an alternative.';
  if (comparisonBusy(snapshot, run)) return 'Wait for building, checking and review to finish.';
  if (snapshot.decisions.some((d) => d.run_id === run.id) || snapshot.repository.pending)
    return 'A publication decision is already in progress.';
  if (snapshot.repository.status !== 'ready') return 'The repository is not ready.';
  if (
    !candidate ||
    candidate.run_id !== run.id ||
    !(reviewOnly
      ? ['eligible', 'rejected'].includes(candidate.status)
      : candidate.status === 'eligible')
  )
    return 'This result needs completed independent checks.';
  const policy = snapshot.repository.policy;
  const evaluation = snapshot.evaluations.find((e) => e.id === candidate.evaluation);
  if (
    !policy ||
    !evaluation ||
    evaluation.candidate !== candidate.id ||
    evaluation.policy !== policy.version ||
    evaluation.revision?.commit !== candidate.revision?.commit ||
    evaluation.revision?.repository !== candidate.revision?.repository ||
    (policy.suite && evaluation.suite !== policy.suite) ||
    (policy.environment && evaluation.environment !== policy.environment) ||
    !/^[a-f0-9]{64}$/.test(evaluation.evidence ?? '') ||
    policy.required_checks.some(
      (name) =>
        !evaluation.checks?.some(
          (check: Record<string, any>) =>
            check.name === name &&
            (reviewOnly ? ['pass', 'fail'].includes(check.status) : check.status === 'pass'),
        ),
    )
  )
    return 'This result needs exact, current-policy verification.';
  const branch = runWorkingBranch(snapshot, run);
  if (run.working_branch_id) {
    const unchangedBase =
      branch?.working_commit === run.base?.commit && branch?.version === run.working_branch_version;
    const ownHead = snapshot.candidates.some(
      (c) => c.id === branch?.latest_candidate_id && c.run_id === run.id,
    );
    if (
      branch?.status !== 'active' ||
      branch.canonical_base_commit !== snapshot.repository.head_commit ||
      branch.canonical_base_version !== snapshot.repository.version ||
      (!unchangedBase && !ownHead)
    )
      return 'The branch or publishing lease changed. Refresh before choosing.';
  } else if (candidate.base?.commit !== snapshot.repository.head_commit)
    return 'The source changed. Refresh before choosing.';
  return undefined;
}

export function latestBuilderCandidates(snapshot: Snapshot, run: Record<string, any>) {
  const executions = snapshot.executions.filter(
    (e) =>
      e.run_id === run.id &&
      e.role === 'coding' &&
      !e.parent_execution &&
      e.comparison_role !== 'repair',
  );
  return executions
    .map((execution, index) => {
      const repairs = snapshot.executions.filter(
        (e) =>
          e.run_id === run.id &&
          e.comparison_role === 'repair' &&
          e.agent_index === (execution.agent_index ?? index),
      );
      const ids = new Set([execution.id, ...repairs.map((e) => e.id)]);
      return [...snapshot.candidates]
        .reverse()
        .find((c) => c.run_id === run.id && ids.has(c.execution));
    })
    .filter((candidate): candidate is Record<string, any> => !!candidate);
}
