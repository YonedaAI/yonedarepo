import { expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { latestBuilderCandidates } from './comparisonView';
import { refreshedSelection } from './refreshedSelection';
import { reviewableCandidates, runAttention, selectionBlocker } from './runReviewState';

// N8 step 12: run B chose `left` on the old main; A published `main-a`; `left` was refreshed.
const run = {
  id: 'run-b',
  mode: 'compare',
  status: 'ready',
  base: { repository: 'source', commit: 'old-main' },
  comparison: { version: 1, status: 'selected', selected_candidate_id: 'left' },
};
const candidate = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  run_id: run.id,
  execution: `run-b:${id}`,
  status: 'eligible',
  base: run.base,
  revision: { repository: 'fork', commit: `${id}-commit` },
  evaluation: `check-${id}`,
  paths: ['app.ts'],
  ...extra,
});
const left = candidate('left');
const right = candidate('right');
const refreshed = candidate('refresh-left', {
  execution: left.execution,
  base: { repository: 'source', commit: 'main-a' },
  refresh_of: 'left',
  conflict_id: 'conflict:refresh',
});
function snapshotWith(candidates: Record<string, any>[]) {
  return {
    repository: {
      id: 'repo',
      status: 'ready',
      head_commit: 'main-a',
      version: 1,
      policy: { version: 'policy', required_checks: ['build'] },
    },
    runs: [run],
    candidates,
    executions: ['left', 'right'].map((id) => ({
      id: `run-b:${id}`,
      run_id: run.id,
      role: 'coding',
      status: 'completed',
    })),
    evaluations: candidates.map((c) => ({
      id: c.evaluation,
      candidate: c.id,
      revision: c.revision,
      policy: 'policy',
      evidence: 'a'.repeat(64),
      checks: [{ name: 'build', status: 'pass' }],
    })),
    decisions: [],
    artifacts: [],
    nodes: [],
    edges: [],
    seq: 1,
  } as unknown as Snapshot;
}

it('treats the checked refresh of the selected result as the publishable selection', () => {
  const snapshot = snapshotWith([left, right, refreshed]);
  expect(refreshedSelection(snapshot, run)?.id).toBe('refresh-left');
  expect(selectionBlocker(snapshot, run, refreshed)).toBeUndefined();
  expect(reviewableCandidates(snapshot, run).map((c) => c.id)).toEqual(['refresh-left']);
  expect(runAttention(snapshot, run).candidate?.id).toBe('refresh-left');
});

it('marks the original pick superseded and stale instead of publishable', () => {
  const snapshot = snapshotWith([left, right, refreshed]);
  expect(selectionBlocker(snapshot, run, left)).toMatch(/superseded/i);
  expect(selectionBlocker(snapshot, run, left)).toMatch(/older main/i);
  expect(selectionBlocker(snapshot, run, right)).toMatch(/Choose this checked result/);
});

it('keeps the original pick as the builder result and the refresh out of the review roster', () => {
  const snapshot = snapshotWith([left, right, refreshed]);
  expect(latestBuilderCandidates(snapshot, run).map((c) => c.id)).toEqual(['left', 'right']);
});

it('does not treat refreshes of an alternative or of another run as the selection', () => {
  const ofRight = candidate('refresh-right', {
    execution: right.execution,
    base: refreshed.base,
    refresh_of: 'right',
  });
  const foreign = { ...refreshed, id: 'foreign', run_id: 'run-a' };
  for (const other of [ofRight, foreign]) {
    const snapshot = snapshotWith([left, right, other]);
    expect(refreshedSelection(snapshot, run)).toBeUndefined();
    expect(selectionBlocker(snapshot, run, other)).toBeTruthy();
  }
});

it('leaves an unrefreshed stale selection with the existing start-an-update guidance', () => {
  const snapshot = snapshotWith([left, right]);
  expect(refreshedSelection(snapshot, run)).toBeUndefined();
  expect(selectionBlocker(snapshot, run, left)).toMatch(/repository has changed/);
});
