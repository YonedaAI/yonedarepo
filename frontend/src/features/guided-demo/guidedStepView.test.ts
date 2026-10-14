import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GuidedStep } from '../../../../shared/guided-runs';
import type { Snapshot } from '../../lib/types';
import { GuidedSessionPanel } from './GuidedSessionPanel';
import { sessionFixture } from './guidedFixture';
import { guidedRunFacts, guidedStepLinks, guidedStepReason } from './guidedStepView';

const step = (changes: Partial<GuidedStep>): GuidedStep => ({
  id: 'concurrent',
  status: 'running',
  run_ids: ['filter-run', 'sort-run'],
  evidence: [],
  next_action: null,
  ...changes,
});
const facts = guidedRunFacts({
  runs: [
    { id: 'filter-run', status: 'failed', guided: { variant: 'filter' } },
    { id: 'sort-run', status: 'ready', guided: { variant: 'sort' } },
    { id: 'plain-a', status: 'running' },
    { id: 'plain-b', status: 'running' },
  ],
  team_tasks: [{ run_id: 'filter-run', status: 'failed', title: 'Independent verification' }],
} as unknown as Snapshot);
const labels = (value: GuidedStep) => guidedStepLinks(value, facts).map((link) => link.label);

describe('guided step links', () => {
  it('names links by outcome and never as inspect concurrent run', () => {
    expect(labels(step({ id: 'build', run_ids: ['b'], status: 'complete' }))).toEqual([
      'View result',
    ]);
    expect(labels(step({ id: 'build', run_ids: ['b'], status: 'running' }))).toEqual(['Open run']);
    expect(labels(step({ status: 'running' }))).toEqual(['Open run', 'Filter run', 'Sort run']);
    expect(labels(step({ run_ids: ['plain-a', 'plain-b'] }))).toEqual([
      'Open run',
      'Run 1',
      'Run 2',
    ]);
    expect(guidedStepLinks(step({ status: 'needs_attention' }), facts)[0]).toMatchObject({
      label: 'Open run',
      runId: 'filter-run',
      primary: true,
    });
  });

  it('explains why a step needs attention from run status, failed task and evidence', () => {
    expect(guidedStepReason(step({ status: 'needs_attention' }), facts)).toBe(
      'Sort finished; the filter run failed during “Independent verification”.',
    );
    expect(
      guidedStepReason(
        step({
          status: 'needs_attention',
          run_ids: ['plain-a', 'plain-b'],
          evidence: [{ kind: 'scoped_resolution', label: 'Resolution', verified: false }],
        }),
        facts,
      ),
    ).toBe('Waiting for both runs to be reconciled and re-checked.');
    expect(guidedStepReason(step({ status: 'running' }), facts)).toBe('');
  });

  it('renders clickable outcome links, the reason and the step retry in the panel', () => {
    const session = sessionFixture();
    session.next_step = 'concurrent';
    session.steps = session.steps.map((item) =>
      item.id === 'concurrent'
        ? step({ status: 'needs_attention' })
        : { ...item, status: item.id === 'review' ? 'locked' : 'complete', run_ids: ['done'] },
    );
    const html = renderToStaticMarkup(
      createElement(GuidedSessionPanel, {
        session,
        busy: false,
        runs: facts,
        onStart: () => {},
        onRetry: () => {},
        onInspect: () => {},
        onRefresh: () => {},
      }),
    );
    expect(html).toContain('class="quiet guided-step-action"');
    expect(html).toContain('Filter run <span aria-hidden="true">→</span>');
    expect(html).toContain('Sort finished; the filter run failed');
    expect(html).toContain('aria-label="Retry this step: Reconcile concurrent changes"');
    expect(html).not.toContain('Inspect concurrent run');
  });
});
