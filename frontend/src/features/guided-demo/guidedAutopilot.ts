import type { GuidedSession, GuidedStepId } from '../../../../shared/guided-runs';

/** Retries per stage before autopilot hands the stage back to the owner. */
export const AUTOPILOT_MAX_ATTEMPTS = 3;

export type AutopilotAction =
  | { kind: 'start'; step: GuidedStepId }
  | { kind: 'retry'; step: GuidedStepId }
  | { kind: 'wait' }
  | { kind: 'stop'; reason: 'review' | 'retries' | 'done' | 'blocked' };

/**
 * Agent stages run back to back without waiting for a click; a failed stage is retried a bounded
 * number of times. Review is never automated: publishing stays the owner's decision.
 */
export function autopilotAction(session: GuidedSession): AutopilotAction {
  if (session.steps.some((step) => step.status === 'running')) return { kind: 'wait' };
  const failed = session.steps.find((step) => step.status === 'needs_attention');
  if (failed) {
    return (failed.attempt ?? 1) < AUTOPILOT_MAX_ATTEMPTS
      ? { kind: 'retry', step: failed.id }
      : { kind: 'stop', reason: 'retries' };
  }
  const next = session.steps.find((step) => step.id === session.next_step);
  if (!next) return { kind: 'stop', reason: 'done' };
  if (next.id === 'review') return { kind: 'stop', reason: 'review' };
  if (next.status === 'ready' && next.next_action) return { kind: 'start', step: next.id };
  return { kind: 'stop', reason: 'blocked' };
}
