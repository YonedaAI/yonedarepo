import type { GuidedSession } from '../../../../shared/guided-runs';
/** Synthetic UI state only, never campaign or agent-work evidence. */
export const sessionFixture = (): GuidedSession => ({
  session_id: 'session-1',
  profile_id: 'task-board-v1',
  version: 1,
  next_step: 'build',
  steps: ['build', 'extend', 'concurrent', 'review'].map((id, index) => ({
    id: id as GuidedSession['next_step'] & string,
    status: index ? 'locked' : 'ready',
    run_ids: [],
    evidence: [],
    next_action: index ? null : 'Build together',
  })),
});
