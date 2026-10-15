import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { RunDetail } from './RunDetail';
import type { InitialRun } from './restartRun';
import { runDraft } from './runDraft';
import { selectionBlocker } from './runReviewState';

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
  onRetry: () => {},
  onRepairTask: async () => true,
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
});

describe('guided working branch continuation', () => {
  it('leaves continuation to the guide instead of offering a free-form brief', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { WorkingBranchPanel } = await import('./WorkingBranchPanel');
    const run = {
      id: 'guide-run',
      status: 'ready',
      working_branch_id: 'guide-b',
      guided: { profile_id: 'task-board-v1', version: 2 },
    };
    const snapshot = {
      repository: { published_commit: 'a'.repeat(40), head_commit: 'a'.repeat(40) },
      runs: [run, { id: 'guide-other', status: 'exploring', working_branch_id: 'guide-b' }],
      executions: [{ id: 'x', run_id: 'guide-other', status: 'running' }],
      working_branches: [
        {
          id: 'guide-b',
          status: 'active',
          working_commit: 'b'.repeat(40),
          working_revision: { repository: 'yoneda-dev/attempt', commit: 'b'.repeat(40) },
          canonical_base_commit: 'a'.repeat(40),
          version: 13,
          latest_candidate_id: 'c',
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(WorkingBranchPanel, {
        snapshot: snapshot as never,
        run,
        reviewer: false,
        busy: false,
        canStart: true,
        onContinue: () => {},
      }),
    );
    expect(html).not.toContain('Continue checked work');
    expect(html).toContain('The guided demo continues this branch');
  });
});
