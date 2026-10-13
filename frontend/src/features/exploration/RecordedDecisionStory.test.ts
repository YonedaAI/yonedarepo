import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { CandidateOutcome } from './CandidateOutcome';
import { PublishedRunNotice } from './PublishedRunNotice';
import { RunWorkflow } from './RunWorkflow';

const run = {
  id: 'run',
  mode: 'collaborate',
  status: 'ready',
  intent: 'Keep calendar filtering accessible.',
  criteria: ['Accented event names remain visible', 'Keyboard filtering works'],
  context: [],
};
const candidate = {
  id: 'integrated',
  run_id: run.id,
  execution: 'integrator',
  status: 'eligible',
  summary: 'Calendar filtering retains accented names.',
  revision: { repository: 'fixture/fork', commit: '123456789abcdef' },
  base: { repository: 'fixture/source', commit: 'base' },
  evaluation: 'evaluation',
  paths: ['calendar.ts', 'calendar.css'],
};
// The complete stored acceptance record, including fields unrelated to presentation.
const decision = {
  id: 'decision',
  request_id: 'request',
  fingerprint: 'fingerprint',
  receipt: 'receipt',
  status: 'published',
  candidate: candidate.id,
  run_id: run.id,
  base: candidate.base,
  target: candidate.revision,
  rationale: 'Preserves anonymous access and the accepted event contract.',
  decision_kind: 'human',
  alternatives: [
    { candidate: 'alternative-one', reason: 'Requires sign-in to filter events.' },
    { candidate: 'alternative-two', reason: 'Drops accented names from search.' },
    { candidate: 'historical-missing', reason: 'Changes the public event contract.' },
  ],
  created_at: 1234,
};
const evaluation = {
  id: 'evaluation',
  candidate: candidate.id,
  revision: candidate.revision,
  policy: 'v1',
  checks: [
    { name: 'accent_filter', status: 'pass', detail: 'Accented names remain visible.' },
    { name: 'keyboard_filter', status: 'skipped', detail: 'Browser fixture unavailable.' },
  ],
};
const snapshot = {
  repository: {
    id: 'repo',
    status: 'ready',
    pending: null,
    head_commit: 'base',
    policy: { version: 'v1' },
  },
  runs: [run],
  candidates: [candidate],
  executions: [],
  evaluations: [evaluation],
  decisions: [],
  team_tasks: [
    {
      run_id: run.id,
      role: 'integrator',
      candidate_id: candidate.id,
      execution_id: candidate.execution,
    },
  ],
  artifacts: [],
  nodes: [],
  edges: [],
  seq: 1,
} as unknown as Snapshot;
const noop = () => {};
function outcome(overrides: Record<string, any> = {}) {
  return renderToStaticMarkup(
    createElement(CandidateOutcome, {
      repo: 'repo',
      candidate,
      evaluation,
      snapshot,
      run,
      onContext: noop,
      onGraph: noop,
      ...overrides,
    }),
  );
}
const surfaces = {
  outcome: (record: typeof decision) => outcome({ decision: record }),
  workflow: (record: typeof decision) =>
    renderToStaticMarkup(
      createElement(RunWorkflow, { snapshot: { ...snapshot, decisions: [record] }, run }),
    ),
  continuation: (record: typeof decision) =>
    renderToStaticMarkup(
      createElement(PublishedRunNotice, {
        publication: { decision: record, candidate, run },
        contextTotal: 0,
      }),
    ),
};

describe('recorded decision story across review, workflow and continuation', () => {
  for (const [surface, render] of Object.entries(surfaces)) {
    it(`${surface} shows the chosen source and every stored rejection reason`, () => {
      const html = render(decision);
      expect(html).toContain('Selected revision');
      expect(html).toContain('123456789');
      expect(html).toContain('fixture/fork');
      expect(html).toContain('integrated');
      expect(html).toContain(decision.rationale);
      for (const alternative of decision.alternatives) {
        expect(html).toContain(alternative.candidate);
        expect(html).toContain(alternative.reason);
      }
    });
    it(`${surface} preserves missing reasons without inventing a tradeoff`, () => {
      const html = render({
        ...decision,
        rationale: '',
        alternatives: [{ candidate: 'historical-missing', reason: '' }],
      });
      expect(html).toContain('No rationale was recorded.');
      expect(html).toContain('No rejection reason was recorded.');
    });
    it(`${surface} identifies fixture selection and failed publication separately`, () => {
      const html = render({
        ...decision,
        decision_kind: 'development_verification',
        status: 'publication_failed',
        error: 'Canonical lease changed.',
      } as typeof decision);
      expect(html).toContain('Automated development selection');
      expect(html).toContain('Publication failed');
      expect(html).toContain('Canonical lease changed.');
      expect(html).not.toContain('Owner decision');
    });
  }
  it('does not describe the rejected result as the chosen revision', () => {
    const html = outcome({
      decision,
      candidate: { ...candidate, id: 'alternative-one', revision: { commit: 'other' } },
    });
    expect(html).toContain('Selected revision');
    expect(html).toContain('123456789');
    expect(html).toContain(decision.alternatives[0].reason);
  });
  it('shows the current human review state and criteria before a decision exists', () => {
    const html = outcome();
    expect(html).toContain('Review required');
    expect(html).toContain('ready for your decision');
    expect(html).toContain('Agent assertion');
    for (const criterion of run.criteria) expect(html).toContain(criterion);
    expect(html).not.toContain('A publishing rationale has not been recorded');
  });
  it('exposes stale source as the pending review blocker', () => {
    const html = outcome({
      snapshot: { ...snapshot, repository: { ...snapshot.repository, head_commit: 'new-base' } },
    });
    expect(html).toContain('Review blocked');
    expect(html).toContain('repository has changed since this run started');
  });
  it('preserves the pending intent question rather than suggesting a decision is ready', () => {
    const html = outcome({ run: { ...run, status: 'awaiting_intent' } });
    expect(html).toContain('Waiting for intent answer');
    expect(html).not.toContain('ready for your decision');
  });
  it('keeps skipped checks visible without claiming every behavior passed', () => {
    const html = outcome();
    expect(html).toContain('skipped');
    expect(html).toContain('Browser fixture unavailable.');
    expect(html).not.toMatch(/all (checks|behaviors) pass/i);
  });
  for (const mismatch of [
    { candidate: 'other' },
    { revision: { ...candidate.revision, commit: 'other' } },
    { revision: { ...candidate.revision, repository: 'other/fork' } },
  ]) {
    it(`withholds check claims for mismatched evidence ${JSON.stringify(mismatch)}`, () => {
      const html = outcome({ evaluation: { ...evaluation, ...mismatch } });
      expect(html).toContain(
        'Independent checks for this exact revision are pending or unavailable.',
      );
      expect(html).not.toContain('Browser fixture unavailable.');
      expect(html).not.toContain('ready for your decision');
    });
  }
});
