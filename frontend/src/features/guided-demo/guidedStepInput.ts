import {
  type GuidedSession,
  type GuidedStepId,
  guidedProfileId,
  type StartGuidedStep,
} from '../../../../shared/guided-runs';
import type { Repository } from '../../lib/types';
export function guidedStepInput(
  session: GuidedSession,
  stepId: GuidedStepId,
  repository: Repository,
): Omit<StartGuidedStep, 'request_id'> {
  const stage = session.steps.find((step) => step.id === stepId);
  if (
    repository.status !== 'ready' ||
    session.next_step !== stepId ||
    stage?.status !== 'ready' ||
    !stage.next_action ||
    session.steps.some((step) => step.status === 'running')
  )
    throw new Error('Refresh the guide before starting its next ready stage.');
  const revision = session.working_revision;
  if (
    (revision && session.working_version === undefined) ||
    (!revision && session.working_version !== undefined)
  )
    throw new Error('The working revision could not be confirmed. Refresh the guide.');
  return {
    session_id: session.session_id,
    profile_id: guidedProfileId,
    step_id: stepId,
    expected_commit: revision?.commit ?? repository.head_commit,
    expected_version: session.working_version ?? repository.version,
  };
}
