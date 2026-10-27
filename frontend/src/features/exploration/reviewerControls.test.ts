import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../lib/types';
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
};
const noop = () => {};
describe('reviewer run permissions', () => {
  it('keeps an unresolved deep link on its requested run instead of showing the newest result', () => {
    const html = renderToStaticMarkup(
      createElement(Exploration, {
        snapshot: { ...snapshot, runs: [{ id: 'reviewer-e5', intent: 'Latest failed trial' }] },
        reviewer: true,
        onChange: async () => {},
        onError: noop,
        onProviders: noop,
        onAgents: noop,
        onContext: noop,
        onSelectedRun: noop,
        initialRunId: 'reviewer-f07',
        requestedRunError: 'Run "reviewer-f07" was not found in this repository history.',
      }),
    );
    expect(html).toContain('reviewer-f07');
    expect(html).toContain('was not found in this repository history');
    expect(html).not.toContain('Latest failed trial');
  });

  it('offers an ordinary reviewer the same brief starters and primary start action', () => {
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
    expect(html).toContain('Start a Run');
    expect(html).toContain('Continue from context');
    expect(html).not.toContain('Start a funded trial');
  });
  it('uses the ordinary start action while retaining explicit historical repair permissions', () => {
    const toolbar = { snapshot, canStart: true, onNewRun: noop, reviewer: true };
    const repair = {
      snapshot,
      run: { id: 'run' },
      busy: false,
      canStart: true,
      onRepair: async () => true,
      reviewer: true,
    };
    expect(renderToStaticMarkup(createElement(RunToolbar, toolbar))).toContain('Start a Run');
    expect(renderToStaticMarkup(createElement(StaleCandidateRepair, repair))).not.toContain(
      'Repair on current revision',
    );
    expect(
      renderToStaticMarkup(createElement(RunToolbar, { ...toolbar, reviewer: false })),
    ).toContain('Start a Run');
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
  it('shows a sandbox team’s task landings in Agent activity', () => {
    const run = {
      id: 'team',
      intent: 'Write the notes',
      status: 'exploring',
      mode: 'collaborate',
      runtime: 'sandbox-cli-v1',
      base: { commit: 'head' },
    };
    const member = {
      id: 'team:agent-1',
      run_id: 'team',
      role: 'coding',
      model: 'glm-5.3-flash',
      status: 'completed',
      sandbox_task: { id: 'notes', title: 'Write the note' },
      landing: { status: 'landed', team_commit: 'c'.repeat(40), version: 1 },
    };
    const html = renderToStaticMarkup(
      createElement(RunDetail, {
        snapshot: { ...snapshot, runs: [run], executions: [member], candidates: [] },
        run,
        reviewer: true,
        busy: false,
        canStart: true,
        onSelectRun: noop,
        onRestart: noop,
        onCancel: noop,
        onAccept: async () => true,
        onContext: noop,
      }),
    );
    expect(html).toContain('Build together');
    expect(html).toContain('Write the note');
    expect(html).toContain('1 / 1 tasks landed on the team branch');
    expect(html).not.toContain('execution-hierarchy-heading');
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
      onAccept: async () => true,
      onProviders: noop,
      onContext: noop,
    };
    const html = renderToStaticMarkup(createElement(RunDetail, props));
    expect(html).not.toContain('Review provider connections');
    expect(html).not.toContain('Restart run</button>');
    expect(html).toContain('Record publishing decision</button>');
    expect(html).not.toMatch(/disabled=""[^>]*>Record publishing decision/);
    expect(renderToStaticMarkup(createElement(RunDetail, { ...props, reviewer: false }))).toContain(
      'Review provider connections',
    );
  });
});
