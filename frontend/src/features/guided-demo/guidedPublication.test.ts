import { expect, it } from 'vitest';
import { comparisonFixture } from '../../../../tests/frontend/comparisonFixture';
import { guidedPublicationState } from '../exploration/guidedPublication';
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

function concurrentFixture(status: Record<string, string>, reviewCandidate = 'left') {
  const f = comparisonFixture();
  const candidate = { ...f.candidates[0], base: { commit: 'canonical' } };
  const session = sessionFixture();
  session.next_step = 'review';
  session.steps = session.steps.map((step) => ({
    ...step,
    status: (status[step.id] ?? (step.id === 'review' ? 'running' : 'complete')) as never,
    candidate_id: reviewCandidate,
    next_action: step.id === 'review' ? 'review_and_publish' : null,
  }));
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
  return { snapshot: { ...f.snapshot, guided_session: session }, run, candidate };
}

it('names each guided blocker with exactly one distinct action', () => {
  const kinds = new Map<string, string>();
  const record = (state?: { kind: string; action: string }) => {
    expect(state).toBeDefined();
    if (state) kinds.set(state.kind, state.action);
    return state?.kind;
  };
  const missing = concurrentFixture({});
  expect(
    record(
      guidedPublicationState(
        { ...missing.snapshot, guided_session: undefined },
        missing.run,
        missing.candidate,
      ),
    ),
  ).toBe('refresh_evidence');
  const active = concurrentFixture({ concurrent: 'running', review: 'locked' });
  expect(record(guidedPublicationState(active.snapshot, active.run, active.candidate))).toBe(
    'active_work',
  );
  const failed = concurrentFixture({ concurrent: 'needs_attention', review: 'locked' });
  expect(record(guidedPublicationState(failed.snapshot, failed.run, failed.candidate))).toBe(
    'failed_work',
  );
  const other = concurrentFixture({}, 'right');
  expect(record(guidedPublicationState(other.snapshot, other.run, other.candidate))).toBe(
    'final_result',
  );
  const rejected = concurrentFixture({});
  expect(
    record(
      guidedPublicationState(rejected.snapshot, rejected.run, {
        ...rejected.candidate,
        owner_rejection: { decision_id: 'decision:no', reason: 'Wrong sort order' },
      }),
    ),
  ).toBe('recorded_decision');
  expect(kinds.size).toBe(5);
  expect(new Set(kinds.values()).size).toBe(5);
  const ready = concurrentFixture({});
  expect(guidedPublicationState(ready.snapshot, ready.run, ready.candidate)).toBeUndefined();
});

it('treats a recorded publication decision as decided but a rejection of another result as history', () => {
  const f = concurrentFixture({});
  const decided = {
    ...f.snapshot,
    decisions: [
      { id: 'decision:a', run_id: f.run.id, status: 'publication_pending', candidate: 'left' },
    ],
  };
  expect(guidedPublicationState(decided, f.run, f.candidate)?.kind).toBe('recorded_decision');
  const rejectedOther = {
    ...f.snapshot,
    decisions: [{ id: 'decision:b', run_id: f.run.id, status: 'rejected', candidate: 'older' }],
  };
  expect(guidedPublicationState(rejectedOther, f.run, f.candidate)).toBeUndefined();
});
