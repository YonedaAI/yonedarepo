import { describe, expect, it } from 'vitest';
import type { GuidedStep } from '../../../../shared/guided-runs';
import type { Snapshot } from '../../lib/types';
import { guidedRunFacts, guidedStepBlock } from './guidedStepView';

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
