import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { TeamWorkflow } from '../team/TeamWorkflow';
import { Exploration } from './Exploration';
import { RunControls } from './RunControls';
import { RunDetail } from './RunDetail';
import { RunToolbar } from './RunToolbar';
import { StaleCandidateRepair } from './StaleCandidateRepair';

// Render each tab's actual content to check permission propagation at every entry point.
vi.mock('./RunTabs', () => ({
  RunTabs: ({ children }: { children: (tab: string) => ReactNode }) =>
    createElement('div', {}, ...['results', 'activity', 'details'].map(children)),
}));

const snapshot: Snapshot = {
  repository: {
    id: 'repo',
    name: 'repo',
    version: 1,
    status: 'ready',
    head_commit: 'head',
    published_commit: 'head',
    pending: null,
    remote: { namespace: 'test', name: 'repo' },
  },
  runs: [],
  executions: [{ id: 'agent', run_id: 'run', role: 'coding' }],
  candidates: [{ id: 'candidate', run_id: 'run', base: { commit: 'old' } }],
  nodes: [],
  edges: [],
  evaluations: [],
  decisions: [],
  artifacts: [],
  seq: 1,
  capabilities: { model_budgets: 1, collaborative_runs: 1 },
  team_tasks: [
    {
      id: 'task',
      task_id: 'task',
      run_id: 'run',
      title: 'Failed task',
      role: 'specialist',
      status: 'failed',
      epoch: 1,
      revision: 1,
      depends_on: [],
    },
  ],
};
const noop = () => {};
describe('reviewer run permissions', () => {
  it('keeps an empty reviewer workspace focused on funded trials without contribution setup', () => {
    const props = {
      snapshot,
      reviewer: true,
      onChange: async () => {},
      onError: noop,
      onProviders: noop,
      onAgents: noop,
      onContext: noop,
      onSelectedRun: noop,
    };
    const html = renderToStaticMarkup(createElement(Exploration, props));
    expect(html).not.toContain('Connect local agent');
    expect(html).not.toContain('New run');
    expect(html).toContain('Start a funded trial');
  });
  it('hides generic new runs and stale repair instead of merely disabling forbidden mutations', () => {
    const toolbar = { snapshot, canStart: true, onNewRun: noop, reviewer: true };
    const repair = {
      snapshot,
      run: { id: 'run' },
      busy: false,
      canStart: true,
      onRepair: noop,
      reviewer: true,
    };
    expect(renderToStaticMarkup(createElement(RunToolbar, toolbar))).not.toContain('New run');
    expect(renderToStaticMarkup(createElement(StaleCandidateRepair, repair))).not.toContain(
      'Repair on current revision',
    );
    expect(
      renderToStaticMarkup(createElement(RunToolbar, { ...toolbar, reviewer: false })),
    ).toContain('New run');
    expect(
      renderToStaticMarkup(createElement(StaleCandidateRepair, { ...repair, reviewer: false })),
    ).toContain('Repair on current revision');
  });
  it('keeps cancellation while hiding restart for reviewers', () => {
    const props = {
      run: { status: 'running' },
      busy: false,
      canStart: true,
      activeAttempts: true,
      hasRoots: true,
      supportsRestart: true,
      onRestart: noop,
      onCancel: noop,
      reviewer: true,
    };
    const html = renderToStaticMarkup(createElement(RunControls, props));
    expect(html).not.toContain('Restart run');
    expect(html).toContain('Cancel run');
    expect(
      renderToStaticMarkup(createElement(RunControls, { ...props, reviewer: false })),
    ).toContain('Restart run');
  });
  it('hides retry on a failed, otherwise retryable team task only for reviewers', () => {
    const props = {
      snapshot,
      run: { id: 'run', status: 'failed' },
      busy: false,
      onRetry: noop,
      onProviders: noop,
      reviewer: true,
    };
    expect(renderToStaticMarkup(createElement(TeamWorkflow, props))).not.toContain('Retry task');
    expect(
      renderToStaticMarkup(createElement(TeamWorkflow, { ...props, reviewer: false })),
    ).toContain('Retry task');
  });
  it('passes permissions through RunDetail, hiding provider changes while preserving eligible candidate review', () => {
    const run = {
      id: 'run',
      intent: 'Review change',
      status: 'awaiting_review',
      base: { commit: 'head' },
    };
    const candidate = {
      id: 'candidate',
      run_id: 'run',
      execution: 'agent',
      status: 'eligible',
      base: { commit: 'head' },
      revision: { commit: 'captured' },
      paths: ['index.html'],
      diff: '+Heading',
      evaluation: 'check',
    };
    const reviewSnapshot = {
      ...snapshot,
      repository: {
        ...snapshot.repository,
        policy: { suite: 'site', version: 'v1', environment: 'test', required_checks: [] },
      },
      runs: [run],
      candidates: [candidate],
      executions: [
        {
          id: 'agent',
          run_id: 'run',
          role: 'coding',
          strategy: 'Minimal',
          status: 'failed',
          error_code: 'PROVIDER_AUTH',
        },
      ],
      evaluations: [{ id: 'check', candidate: 'candidate', policy: 'v1', checks: [] }],
    };
    const props = {
      snapshot: reviewSnapshot,
      run,
      reviewer: true,
      busy: false,
      canStart: true,
      onSelectRun: noop,
      onRestart: noop,
      onCancel: noop,
      onRetry: noop,
      onAccept: async () => true,
      onProviders: noop,
      onContext: noop,
    };
    const html = renderToStaticMarkup(createElement(RunDetail, props));
    expect(html).not.toContain('Review provider connections');
    expect(html).not.toContain('Restart run</button>');
    expect(html).toContain('Review approach</button>');
    expect(html).not.toMatch(/disabled=""[^>]*>Review approach/);
    expect(renderToStaticMarkup(createElement(RunDetail, { ...props, reviewer: false }))).toContain(
      'Review provider connections',
    );
  });
});
