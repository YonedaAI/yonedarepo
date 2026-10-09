import type { Snapshot } from '../../lib/types';
import { runCandidates } from '../team/teamView';
import { runHasActiveAttempts } from './runControlState';

type RecordValue = Record<string, any>;
export type RunAttentionState = {
  tone: 'review' | 'blocked' | 'working' | 'published' | 'neutral';
  title: string;
  detail: string;
  action?: 'review' | 'activity' | 'results' | 'details';
  actionLabel?: string;
  candidate?: RecordValue;
};

/** Presentation guard only. Selection is revalidated by the repository authority. */
export function selectionBlocker(snapshot: Snapshot, run: RecordValue, candidate?: RecordValue) {
  const decision = snapshot.decisions.find((item) => item.run_id === run.id);
  if (decision) return 'A shipping decision has already been recorded for this run.';
  if (run.status === 'cancelled') return 'This run was cancelled.';
  if (run.status === 'accepted') return 'This run has already been selected.';
  if (!candidate) return 'Waiting for a captured result.';
  if (candidate.status !== 'eligible') return 'This result has not passed the required checks.';
  if (snapshot.repository.pending) return 'Another publication is in progress in this repository.';
  if (snapshot.repository.status !== 'ready') return 'The repository is not ready for publication.';
  if (candidate.base?.commit !== snapshot.repository.head_commit)
    return 'The repository has changed since this run started. Start an update from the current source.';
  const evaluation = snapshot.evaluations.find((item) => item.id === candidate.evaluation);
  if (
    !evaluation ||
    !snapshot.repository.policy?.version ||
    evaluation.policy !== snapshot.repository.policy.version
  )
    return 'The required check policy has changed. This result needs current verification.';
  return undefined;
}

export function reviewableCandidates(snapshot: Snapshot, run: RecordValue) {
  return runCandidates(snapshot, run).filter(
    (candidate) => !selectionBlocker(snapshot, run, candidate),
  );
}

/** Prioritize a recorded publication, then a usable result, then failure recovery and progress. */
export function runAttention(snapshot: Snapshot, run: RecordValue): RunAttentionState {
  const decision = snapshot.decisions.find((item) => item.run_id === run.id);
  if (decision?.status === 'published')
    return {
      tone: 'published',
      title: 'Published',
      detail: 'The shipping decision and canonical source revision are recorded.',
      action: 'details',
      actionLabel: 'View decision',
    };
  if (decision?.status === 'publication_failed')
    return {
      tone: 'blocked',
      title: 'Publication failed',
      detail:
        decision.error ||
        'The decision was recorded, but publication did not complete. Inspect the failure before continuing.',
      action: 'details',
      actionLabel: 'View publication details',
    };
  if (decision)
    return {
      tone: 'working',
      title: 'Publication in progress',
      detail: 'Your decision is recorded. Source verification and publication are still pending.',
      action: 'details',
      actionLabel: 'View decision',
    };
  if (run.status === 'cancelled')
    return {
      tone: 'neutral',
      title: 'Run cancelled',
      detail: 'Work has stopped. Captured source and recorded evidence remain available.',
      action: 'details',
      actionLabel: 'View run details',
    };
  const executions = snapshot.executions.filter((execution) => execution.run_id === run.id);
  const failed = executions.filter((execution) => execution.status === 'failed').length;
  const reviewable = reviewableCandidates(snapshot, run);
  if (reviewable.length)
    return {
      tone: 'review',
      title: 'Review required',
      detail: `${run.mode === 'collaborate' ? 'The integrated team result is' : `${reviewable.length} result${reviewable.length === 1 ? ' is' : 's are'}`} independently checked and ready for your decision. Nothing from this run has been published.${failed ? ` ${failed} agent attempt${failed === 1 ? '' : 's'} failed; their evidence is in Agent activity.` : ''}`,
      action: 'review',
      actionLabel:
        reviewable.length > 1
          ? 'Review approaches'
          : run.mode === 'collaborate'
            ? 'Review integrated result'
            : 'Review result',
      candidate: reviewable.length === 1 ? reviewable[0] : undefined,
    };
  const eligible = runCandidates(snapshot, run).find(
    (candidate) => candidate.status === 'eligible',
  );
  if (eligible)
    return {
      tone: 'blocked',
      title: 'Review blocked',
      detail: selectionBlocker(snapshot, run, eligible) ?? 'This result cannot be selected yet.',
      action: 'results',
      actionLabel: 'Inspect result',
    };
  if (failed || run.status === 'failed')
    return {
      tone: 'blocked',
      title: 'Agent work needs attention',
      detail: `${failed ? `${failed} agent attempt${failed === 1 ? '' : 's'} stopped before completion.` : 'This run did not complete.'} ${runHasActiveAttempts(snapshot, run) ? 'Other work is still active.' : 'No result is ready to publish.'} Inspect the failure and available recovery actions.`,
      action: 'activity',
      actionLabel: 'Inspect agent activity',
    };
  const candidates = runCandidates(snapshot, run);
  if (candidates.some((candidate) => candidate.status === 'rejected'))
    return {
      tone: 'blocked',
      title: 'Changes did not pass checks',
      detail:
        'The captured results are available, but none passed the required checks. Review the check details before starting another attempt.',
      action: 'results',
      actionLabel: 'Inspect checks',
    };
  if (candidates.length)
    return {
      tone: 'working',
      title: 'Checks in progress',
      detail:
        'Source has been captured. Independent verification must finish before a shipping decision.',
      action: 'results',
      actionLabel: 'View results',
    };
  return {
    tone: 'working',
    title: run.status === 'planning' ? 'Agents are planning' : 'Agents are working',
    detail:
      'No shipping decision is needed yet. Task progress, handoffs and execution logs are in Agent activity.',
    action: 'activity',
    actionLabel: 'View agent activity',
  };
}
