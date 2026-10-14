import { expect, it } from 'vitest';
import { comparisonFixture } from '../../../../tests/frontend/comparisonFixture';
import { selectionBlocker } from '../exploration/runReviewState';
import { sessionFixture } from './guidedFixture';

it('prevents partial guided results from exposing canonical publishing while preserving ordinary runs', () => {
  const f = comparisonFixture();
  const candidate = { ...f.candidates[0], base: { commit: 'canonical' } };
  const run = {
    ...f.run,
    mode: 'collaborate',
    working_branch_id: undefined,
    guided: { version: 1, profile_id: 'task-board-v1', session_id: 'session-1', step_id: 'build' },
  };
  expect(selectionBlocker(f.snapshot, run, candidate)).toMatch(/guide/i);
  expect(selectionBlocker(f.snapshot, { ...run, guided: undefined }, candidate)).toBeUndefined();
});
it('permits only the exact final candidate qualified by current server guide evidence', () => {
  const f = comparisonFixture();
  const candidate = { ...f.candidates[0], base: { commit: 'canonical' } };
  const session = sessionFixture();
  session.next_step = 'review';
  session.steps = session.steps.map((step) => ({
    ...step,
    status: step.id === 'review' ? 'running' : 'complete',
    candidate_id: candidate.id,
    next_action: step.id === 'review' ? 'review_and_publish' : null,
  }));
  const snapshot = { ...f.snapshot, guided_session: session };
  const run = {
    ...f.run,
    mode: 'collaborate',
    working_branch_id: undefined,
    guided: {
      version: 1,
      profile_id: 'task-board-v1',
      session_id: 'session-1',
      step_id: 'concurrent',
    },
  };
  expect(selectionBlocker(snapshot, run, candidate)).toBeUndefined();
  expect(selectionBlocker(snapshot, run, { ...candidate, id: 'other' })).toMatch(/guide/i);
});
