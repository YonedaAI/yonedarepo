import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import {
  type ActivityEvent,
  activityLabel,
  elapsedTime,
  eventExecution,
  eventInRun,
  executionElapsed,
} from './activityView';

const snapshot = {
  executions: [
    { id: 'run:agent', run_id: 'run', team_task_revision: 2 },
    { id: 'run:agent-other', run_id: 'other' },
  ],
  candidates: [
    { id: 'candidate', run_id: 'run', execution: 'run:agent', capture_job: 'capture:run:agent:r2' },
  ],
  decisions: [{ id: 'decision', run_id: 'run' }],
} as unknown as Snapshot;
function event(kind: string, data: ActivityEvent['data']): ActivityEvent {
  return { seq: 1, at: 6000, kind, data };
}
describe('ledger activity attribution', () => {
  it.each(['job:run:agent', 'capture:run:agent:r2', 'evaluate:candidate'])(
    'attributes %s to the exact agent',
    (id) => {
      const item = event('job.started', { id });
      expect(eventExecution(item, snapshot, 'run')?.id).toBe('run:agent');
      expect(eventInRun(item, snapshot, 'run')).toBe(true);
    },
  );
  it('does not mistake a neighboring ID or another run for the selected agent', () => {
    expect(eventInRun(event('job.started', { id: 'job:run:agent-other' }), snapshot, 'run')).toBe(
      false,
    );
    expect(eventInRun(event('run.created', { id: 'other' }), snapshot, 'run')).toBe(false);
  });
  it('retains run cancellation, publication and usage events without an agent ID', () => {
    expect(eventInRun(event('run.cancelled', { id: 'run' }), snapshot, 'run')).toBe(true);
    expect(eventInRun(event('job.completed', { id: 'publish:decision' }), snapshot, 'run')).toBe(
      true,
    );
    expect(
      eventInRun(
        event('model.request_settled', { reservation: { run_id: 'run', job_id: 'job:run:agent' } }),
        snapshot,
        'run',
      ),
    ).toBe(true);
  });
  it('includes the shipping receipt by its recorded decision identity', () => {
    expect(
      eventInRun(
        event('decision.selected', { id: 'decision', status: 'publication_pending' }),
        snapshot,
        'run',
      ),
    ).toBe(true);
    expect(
      eventInRun(
        event('decision.selected', { id: 'other-decision', status: 'publication_pending' }),
        snapshot,
        'run',
      ),
    ).toBe(false);
  });
  it('describes evaluator completion as checks without implying publication', () => {
    expect(activityLabel(event('job.completed', { kind: 'evaluate' }))).toBe(
      'Independent checks completed',
    );
  });
  it('formats elapsed duration and fences negative clock differences', () => {
    expect(elapsedTime(65000)).toBe('1m 5s');
    expect(elapsedTime(3660000)).toBe('1h 1m');
    expect(elapsedTime(-1000)).toBe('0s');
  });
});

it('stops terminal agent elapsed time at the recorded failure, including retries', () => {
  const execution = { ...snapshot.executions[0], status: 'failed', started_at: 1000 };
  const failed = { ...event('job.failed', { id: 'job:run:agent' }), at: 6000 };
  expect(executionElapsed(execution, [failed], snapshot, 'run', 90000)).toBe(5000);
  expect(executionElapsed(execution, [], snapshot, 'run', 90000)).toBeNull();
  expect(
    executionElapsed({ ...execution, status: 'running' }, [failed], snapshot, 'run', 90000),
  ).toBe(89000);
});
