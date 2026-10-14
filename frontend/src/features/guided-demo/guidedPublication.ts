import { guidedProfileId, isGuidedProfileVersion } from '../../../../shared/guided-runs';
import type { Snapshot } from '../../lib/types';
/** Presentation only. Native publication independently validates the full resolved guide chain. */
export function guidedPublicationBlocker(
  snapshot: Snapshot,
  run: Record<string, any>,
  candidate?: Record<string, any>,
) {
  const guide = run.guided;
  if (!guide || guide.profile_id !== guidedProfileId || !isGuidedProfileVersion(guide.version))
    return;
  if (guide.step_id !== 'concurrent')
    return 'Continue the guided demo before publishing this stage.';
  const session = snapshot.guided_session;
  const review = session?.steps.find((step) => step.id === 'review');
  if (
    !session ||
    !review ||
    session.session_id !== guide.session_id ||
    session.next_step !== 'review' ||
    !session.steps
      .filter((step) => step.id !== 'review')
      .every((step) => step.status === 'complete') ||
    !['ready', 'running'].includes(review.status) ||
    !review.next_action
  )
    return 'The guide is still reconciling and checking its final result. Open the guided demo to refresh its evidence before publishing.';
  if (review.candidate_id !== candidate?.id)
    return 'This is not the guide’s final result. Use Review & publish in the guided demo to open the reconciled result.';
}
