import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { RunDetail } from './RunDetail';
import type { InitialRun } from './restartRun';
import { runDraft } from './runDraft';
import { runAttention, selectionBlocker } from './runReviewState';

const revision = { repository: 'fixture/fork', commit: 'checked' };
const branch = {
  id: 'development',
  status: 'active',
  version: 2,
  working_commit: 'checked',
  working_revision: revision,
  canonical_base_commit: 'published',
  canonical_base_version: 1,
  latest_candidate_id: 'candidate',
};
const run = {
  id: 'run',
  mode: 'compare',
  intent: 'Fix the calendar',
  status: 'ready',
  working_branch_id: branch.id,
  base: { commit: 'previous-working' },
  comparison: { version: 1, status: 'selected', selected_candidate_id: 'candidate' },
};
const candidate = {
  id: 'candidate',
  run_id: run.id,
  execution: 'agent',
  status: 'eligible',
  base: run.base,
  revision,
  paths: ['calendar.mjs'],
  evaluation: 'evaluation',
};
const snapshot = {
  repository: {
    id: 'repo',
    head_commit: 'published',
    version: 1,
    status: 'ready',
    pending: null,
    policy: { version: 'policy' },
  },
  runs: [run],
  working_branches: [branch],
  capabilities: { working_branches: 1 },
  executions: [{ id: 'agent', role: 'coding', run_id: run.id, status: 'completed' }],
  candidates: [candidate],
  evaluations: [
    { id: 'evaluation', candidate: candidate.id, revision, policy: 'policy', checks: [] },
  ],
  decisions: [],
  artifacts: [],
  nodes: [],
  edges: [],
  seq: 9,
} as unknown as Snapshot;
const props = {
  snapshot,
  run,
  busy: false,
  canStart: true,
  onSelectRun: () => {},
  onRestart: () => {},
  onCancel: () => {},
  onAccept: async () => true,
  onContext: () => {},
  onContinueBranch: () => {},
};
const render = (changes = {}) =>
  renderToStaticMarkup(createElement(RunDetail, { ...props, ...changes }));
describe('checked working branch review', () => {
  it('offers a separate editable continuation while keeping canonical publication explicit', () => {
    const html = render();
    expect(html).toContain('Checked working branch');
    expect(html).toContain('Continue checked work');
    expect(html).toContain('Canonical source');
    expect(html).not.toContain('Start an update from the current source');
  });
  it('permits publishing only the current branch candidate against its unchanged canonical lease', () => {
    expect(selectionBlocker(snapshot, run, candidate)).toBeUndefined();
    expect(
      selectionBlocker(
        { ...snapshot, repository: { ...snapshot.repository, version: 2 } },
        run,
        candidate,
      ),
    ).toBeTruthy();
    expect(selectionBlocker(snapshot, run, { ...candidate, id: 'old-candidate' })).toBeTruthy();
  });
  it('uses the checked branch lease rather than restart semantics and preserves approved budgets', () => {
    const budgets = { approved: { requests: '10', minutes: '5', outputTokens: '2000' } };
    const source = {
      id: run.id,
      intent: '',
      criteria: ['Keep access'],
      context: ['constraint'],
      agents: [],
      budgets,
      mode: 'compare',
      workingBranch: branch,
    } as unknown as InitialRun;
    const draft = runDraft(snapshot, source);
    expect(draft.restartOf).toBeUndefined();
    expect(draft).toHaveProperty('workingBranch', branch);
    expect(draft.budgets).toEqual(budgets);
    expect(draft.publication).toBeUndefined();
  });
  it('asks the owner to choose between checked compare results before any is selected', () => {
    const unchosen = { ...run, comparison: undefined };
    const atBase = { ...branch, version: 0, latest_candidate_id: null };
    const second = { ...candidate, id: 'second', execution: 'agent' };
    const fresh = {
      ...snapshot,
      runs: [unchosen],
      working_branches: [atBase],
      candidates: [candidate, second],
    } as unknown as Snapshot;
    expect(selectionBlocker(fresh, unchosen, candidate)).toBe(
      'Choose this checked result before publishing it.',
    );
    expect(runAttention(fresh, unchosen)).toMatchObject({
      tone: 'review',
      title: 'Choose a result',
      action: 'results',
    });
  });
});
