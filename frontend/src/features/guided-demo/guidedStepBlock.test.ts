import { describe, expect, it } from 'vitest';
import type { GuidedStep } from '../../../../shared/guided-runs';
import type { Snapshot } from '../../lib/types';
import { guidedRunFacts, guidedStepBlock, guidedStepProgress } from './guidedStepView';

const step = {
  id: 'concurrent',
  status: 'running',
  run_ids: ['run-f', 'run-s'],
  evidence: [],
} as unknown as GuidedStep;
const snapshot = (resolver: string, extra: Record<string, any>[] = []) =>
  ({
    runs: [
      { id: 'run-f', status: 'ready', guided: { variant: 'filter' } },
      { id: 'run-s', status: 'exploring', guided: { variant: 'sort' } },
    ],
    team_tasks: [],
    executions: [
      {
        id: 'res',
        run_id: 'run-s',
        status: resolver,
        strategy: 'Autonomous three-way conflict resolver',
        error: 'RUNTIME: error: RPC failed; HTTP 409\nfatal: expected flush',
      },
      ...extra,
    ],
    jobs: [],
  }) as unknown as Snapshot;

describe('guided step block', () => {
  it('shows a failed agent immediately while its run is still open', () => {
    const block = guidedStepBlock(step, guidedRunFacts(snapshot('failed')));
    expect(block?.message).toContain(
      'Sort run is blocked. Autonomous three-way conflict resolver: RUNTIME: error: RPC failed; HTTP 409',
    );
    expect(block?.stuck).toBe(true);
  });
  it('is not stuck while another agent of the step is still working', () => {
    const block = guidedStepBlock(
      step,
      guidedRunFacts(snapshot('failed', [{ id: 'coord', run_id: 'run-s', status: 'running' }])),
    );
    expect(block?.stuck).toBe(false);
  });
  it('shows nothing when no agent failed', () => {
    expect(guidedStepBlock(step, guidedRunFacts(snapshot('running')))).toBeNull();
  });
});

describe('guided step progress', () => {
  it('shows elapsed time and who is working now', () => {
    const facts = guidedRunFacts({
      runs: [
        { id: 'run-f', status: 'exploring' },
        { id: 'run-s', status: 'exploring' },
      ],
      team_tasks: [],
      jobs: [],
      executions: [
        { id: 'a', run_id: 'run-f', status: 'completed', team_role: 'worker', started_at: 1_000 },
        {
          id: 'b',
          run_id: 'run-s',
          status: 'running',
          team_role: 'integrator',
          started_at: 60_000,
        },
      ],
    } as unknown as Snapshot);
    expect(guidedStepProgress(step, facts, 1_000 + 372_000)).toBe(
      'Running 6 min 12 s · now: integrator',
    );
  });
});
