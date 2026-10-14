import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { runCandidates } from './teamView';

describe('team run results', () => {
  it('shows only the latest recorded conflict resolution once the run is reconciled', () => {
    const run = { id: 'run-1', mode: 'collaborate' };
    const snapshot = {
      team_tasks: [
        { run_id: 'run-1', role: 'integrator', candidate_id: 'cand-int', execution_id: 'exec-int' },
      ],
      candidates: [
        { id: 'cand-int', run_id: 'run-1', execution: 'exec-int' },
        { id: 'cand-spec', run_id: 'run-1', execution: 'exec-spec' },
        { id: 'cand-resolved', run_id: 'run-1', execution: 'exec-res', conflict_id: 'conflict-1' },
        { id: 'cand-other', run_id: 'run-2', execution: 'exec-x', conflict_id: 'conflict-2' },
      ],
    } as unknown as Snapshot;
    expect(runCandidates(snapshot, run).map((candidate) => candidate.id)).toEqual([
      'cand-resolved',
    ]);
  });
});
