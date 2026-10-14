import { guidedProfileId } from '../../../../shared/guided-runs';
import type { Snapshot } from '../../lib/types';

/** Each blocker names one distinct situation and exactly one next action. */
export type GuidedBlockerKind =
  | 'refresh_evidence'
  | 'active_work'
  | 'failed_work'
  | 'final_result'
  | 'recorded_decision';

export type GuidedBlocker = { kind: GuidedBlockerKind; message: string; action: string };

const actions: Record<GuidedBlockerKind, string> = {
  refresh_evidence: 'Refresh guide evidence',
  active_work: 'Inspect active work',
  failed_work: 'Retry failed work',
  final_result: 'Open the final result',
  recorded_decision: 'View recorded decision',
};

const titles: Record<GuidedBlockerKind, string> = {
  refresh_evidence: 'Guide evidence needs a refresh',
  active_work: 'Guide work is still running',
  failed_work: 'Guide work needs a retry',
  final_result: 'Publish from the guide’s final result',
  recorded_decision: 'A decision is recorded',
};

export const guidedBlockerTitle = (kind: GuidedBlockerKind) => titles[kind];

const blocker = (kind: GuidedBlockerKind, message: string): GuidedBlocker => ({
  kind,
  message,
  action: actions[kind],
});

/** Presentation only. Native publication independently validates the full resolved guide chain. */
export function guidedPublicationState(
  snapshot: Snapshot,
  run: Record<string, any>,
  candidate?: Record<string, any>,
): GuidedBlocker | undefined {
  const guide = run.guided;
  if (!guide || guide.profile_id !== guidedProfileId || guide.version !== 1) return;
  if (candidate?.owner_rejection)
    return blocker(
      'recorded_decision',
      'You rejected this result. The decision and its reason are recorded; retry the concurrent changes from the guided demo.',
    );
  if (snapshot.decisions.some((item) => item.run_id === run.id && item.status !== 'rejected'))
    return blocker('recorded_decision', 'A publishing decision is already recorded for this run.');
  if (guide.step_id !== 'concurrent')
    return blocker(
      'final_result',
      'This is an earlier guide stage. Publication uses the guide’s final reconciled result.',
    );
  const session = snapshot.guided_session;
  const review = session?.steps.find((step) => step.id === 'review');
  if (!session || !review || session.session_id !== guide.session_id)
    return blocker(
      'refresh_evidence',
      'The guide’s evidence for this run is not loaded. Refresh it before publishing.',
    );
  const earlier = session.steps.filter((step) => step.id !== 'review');
  if (earlier.some((step) => step.status === 'needs_attention'))
    return blocker(
      'failed_work',
      'A guide stage stopped before completing. Retry it from the guided demo.',
    );
  if (earlier.some((step) => step.status !== 'complete'))
    return blocker('active_work', 'The guide is still reconciling and checking its final result.');
  if (
    session.next_step !== 'review' ||
    !['ready', 'running'].includes(review.status) ||
    !review.next_action
  )
    return blocker(
      'refresh_evidence',
      'The guide’s review evidence is not current. Refresh it before publishing.',
    );
  if (review.candidate_id !== candidate?.id)
    return blocker(
      'final_result',
      'This is not the guide’s final result. Open the reconciled result to review and publish it.',
    );
}

/** Message form used by the shared publishing guard. */
export function guidedPublicationBlocker(
  snapshot: Snapshot,
  run: Record<string, any>,
  candidate?: Record<string, any>,
) {
  return guidedPublicationState(snapshot, run, candidate)?.message;
}
