import { describe, expect, it } from 'vitest';
import type { GuidedSession } from '../../../../shared/guided-runs';
import { autopilotAction } from './guidedAutopilot';

const step = (id: string, status: string, attempt = 1, next_action: string | null = null) => ({
  id,
  status,
  attempt,
  next_action,
  run_ids: [],
  evidence: [],
});
const session = (steps: ReturnType<typeof step>[], next_step: string | null) =>
  ({
    session_id: 's',
    profile_id: 'task-board-v1',
    version: 2,
    steps,
    next_step,
  }) as unknown as GuidedSession;

describe('guided autopilot', () => {
  it('starts the next agent stage as soon as the previous one completes', () => {
    const s = session(
      [
        step('build', 'complete'),
        step('extend', 'ready', 1, 'start'),
        step('concurrent', 'locked'),
        step('review', 'locked'),
      ],
      'extend',
    );
    expect(autopilotAction(s)).toEqual({ kind: 'start', step: 'extend' });
  });
  it('waits while a stage is running', () => {
    const s = session(
      [
        step('build', 'running'),
        step('extend', 'locked'),
        step('concurrent', 'locked'),
        step('review', 'locked'),
      ],
      'build',
    );
    expect(autopilotAction(s)).toEqual({ kind: 'wait' });
  });
  it('retries a stage that needs attention, up to its retry limit', () => {
    const failed = session(
      [
        step('build', 'complete'),
        step('extend', 'needs_attention', 2),
        step('concurrent', 'locked'),
        step('review', 'locked'),
      ],
      'extend',
    );
    expect(autopilotAction(failed)).toEqual({ kind: 'retry', step: 'extend' });
    const exhausted = session(
      [
        step('build', 'complete'),
        step('extend', 'needs_attention', 3),
        step('concurrent', 'locked'),
        step('review', 'locked'),
      ],
      'extend',
    );
    expect(autopilotAction(exhausted)).toEqual({ kind: 'stop', reason: 'retries' });
  });
  it('stops at review: publishing is the owner decision', () => {
    const s = session(
      [
        step('build', 'complete'),
        step('extend', 'complete'),
        step('concurrent', 'complete'),
        step('review', 'ready', 1, 'review_and_publish'),
      ],
      'review',
    );
    expect(autopilotAction(s)).toEqual({ kind: 'stop', reason: 'review' });
  });
});
