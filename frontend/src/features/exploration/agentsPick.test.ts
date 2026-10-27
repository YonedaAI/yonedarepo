import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { comparisonFixture } from '../../../../tests/frontend/comparisonFixture';
import type { Snapshot } from '../../lib/types';
import { activeDecision, rejectionOf, supersededResults } from './agentsPick';
import { pendingLanding } from './platformPublication';
import { RunCandidates } from './RunCandidates';
import { runAttention, selectionBlocker } from './runReviewState';

function teamFixture() {
  const f = comparisonFixture();
  const run = {
    ...f.run,
    mode: 'collaborate',
    runtime: 'sandbox-cli-v1',
    working_branch_id: undefined,
  };
  const earlier = { ...f.candidates[0], id: 'integrated', execution: `${run.id}:team` };
  const current = {
    ...f.candidates[1],
    id: 'reconciled',
    execution: 'run:resolver',
    conflict_id: 'conflict:one',
    base: { commit: 'canonical' },
  };
  const snapshot = {
    ...f.snapshot,
    runs: [run],
    candidates: [earlier, current],
  } as unknown as Snapshot;
  return { snapshot, run, earlier, current };
}

it('keeps superseded team results as history', () => {
  const f = teamFixture();
  expect(supersededResults(f.snapshot, f.run, [f.current]).map((item) => item.id)).toEqual([
    'integrated',
  ]);
});

it('treats an owner rejection as a recorded decision that blocks only that result', () => {
  const f = teamFixture();
  const rejection = {
    id: 'decision:no',
    run_id: f.run.id,
    status: 'rejected',
    candidate: 'reconciled',
    reason: 'Sort breaks filter',
  };
  const snapshot = {
    ...f.snapshot,
    decisions: [rejection],
    candidates: [f.earlier, { ...f.current, owner_rejection: { decision_id: rejection.id } }],
  } as unknown as Snapshot;
  const rejected = snapshot.candidates[1];
  expect(activeDecision(snapshot, f.run)).toBeUndefined();
  expect(rejectionOf(snapshot, rejected)).toBe(rejection);
  expect(selectionBlocker(snapshot, f.run, rejected)).toMatch(/rejected/i);
  expect(selectionBlocker(snapshot, f.run, f.earlier)).not.toMatch(/already been recorded/);
  const attention = runAttention(snapshot, { ...f.run, mode: 'compare' });
  expect(attention.title).not.toBe('Publication in progress');
});

it('finishes only a pending publication, landing its exact target on the leased head', () => {
  const f = comparisonFixture();
  const repository = {
    ...f.snapshot.repository,
    pending: 'decision:a',
    platform_repo: 'r0123456789abcdef0123',
  };
  const decision = {
    id: 'decision:a',
    status: 'publication_pending',
    target: { commit: 'target' },
    publication_expected: { commit: 'leased' },
    checks_overridden: false,
  };
  expect(pendingLanding(repository, decision)).toEqual({
    platform_repo: 'r0123456789abcdef0123',
    ref: 'main',
    commit: 'target',
    expected: 'leased',
    break_glass: false,
  });
  expect(pendingLanding(repository, { ...decision, status: 'publication_conflict' })).toBeNull();
  expect(pendingLanding({ ...repository, platform_repo: undefined }, decision)).toBeNull();
  expect(pendingLanding(repository, { ...decision, checks_overridden: true })?.break_glass).toBe(
    true,
  );
});

function renderPick(snapshot: Snapshot, run: Record<string, any>, current: Record<string, any>) {
  return renderToStaticMarkup(
    createElement(RunCandidates, {
      snapshot,
      run,
      selected: '',
      busy: false,
      comparing: false,
      candidates: [current],
      onCompare: () => {},
      onSelect: () => {},
      onContext: () => {},
      onGraph: () => {},
      onReject: () => {},
      focus: { candidate: current.id, request: 1 },
    }),
  );
}

it('renders one team result with approve and reject, and collapsed history', () => {
  const f = teamFixture();
  const html = renderPick(f.snapshot, f.run, f.current);
  expect(html).toContain('Team result');
  expect(html).toContain('Reconciled team result');
  expect(html).toContain('Approve &amp; publish');
  expect(html).toContain('>Reject<');
  expect(html).toContain('Earlier results (superseded) · 1');
  expect(html).not.toMatch(/<details[^>]*superseded-results[^>]*open/);
  expect(html).toContain('candidate  inspected');
  expect(html.match(/class="candidate /g)).toHaveLength(1);
});

it('shows a rejected team result as a recorded decision without publish or reject actions', () => {
  const f = teamFixture();
  const rejection = {
    id: 'decision:no',
    run_id: f.run.id,
    status: 'rejected',
    candidate: 'reconciled',
    reason: 'Sort breaks filter',
  };
  const current = { ...f.current, owner_rejection: { decision_id: rejection.id } };
  const snapshot = {
    ...f.snapshot,
    decisions: [rejection],
    candidates: [f.earlier, current],
  } as unknown as Snapshot;
  const html = renderPick(snapshot, f.run, current);
  expect(html).toContain('You rejected this result');
  expect(html).toContain('Sort breaks filter');
  expect(html).not.toContain('Approve &amp; publish');
  expect(html).not.toContain('>Reject<');
});
