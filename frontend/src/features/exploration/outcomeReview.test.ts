import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../lib/types';

const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: () => {},
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.states)) hooks.states[i] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.states[i],
      (value: unknown) => {
        hooks.states[i] = typeof value === 'function' ? value(hooks.states[i]) : value;
      },
    ];
  },
}));

import { Dialog } from '../../components/Dialog';
import { AgentWorkSummary } from './AgentWorkSummary';
import { CandidateOutcome } from './CandidateOutcome';
import { RunAttention } from './RunAttention';
import { RunDetail } from './RunDetail';

const run = {
  id: 'run',
  status: 'ready',
  mode: 'compare',
  base: { commit: 'base' },
  intent:
    'Fix calendar filtering while preserving anonymous access and the established event contract.',
  criteria: ['Filtering retains accented event names'],
  context: [],
  context_records: [],
};
const candidate = {
  id: 'captured',
  run_id: run.id,
  execution: 'agent',
  status: 'eligible',
  summary: 'Calendar filtering now retains accented names.',
  base: { commit: 'base' },
  revision: { repository: 'fixture/fork', commit: 'exact' },
  paths: ['public/calendar.mjs'],
  evaluation: 'check',
};
const snapshot = {
  repository: {
    id: 'repo',
    status: 'ready',
    pending: null,
    head_commit: 'base',
    policy: { version: 'v1', required_checks: ['calendar-behavior'] },
  },
  runs: [run],
  executions: [
    {
      id: 'agent',
      run_id: run.id,
      role: 'coding',
      strategy: 'Calendar specialist',
      status: 'completed',
    },
  ],
  candidates: [candidate],
  evaluations: [
    {
      id: 'check',
      candidate: candidate.id,
      revision: candidate.revision,
      policy: 'v1',
      checks: [
        { name: 'calendar-behavior', status: 'pass', detail: 'Accented events remain visible.' },
      ],
      deployment: { digest: 'fixture' },
    },
  ],
  decisions: [],
  artifacts: [],
  nodes: [],
  edges: [],
  seq: 8,
} as unknown as Snapshot;
const noop = () => {};
const props = {
  snapshot,
  run,
  busy: false,
  canStart: true,
  onSelectRun: noop,
  onRestart: noop,
  onCancel: noop,
  onAccept: async () => true,
  onContext: noop,
};
function render(input = props) {
  hooks.cursor = 0;
  return RunDetail(input);
}
function find(node: ReactNode, type: unknown): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) return node.map((item) => find(item, type)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const element = node as ReactElement<Record<string, any>>;
  return element.type === type ? element : find(element.props.children, type);
}
beforeEach(() => {
  hooks.states = [];
  hooks.cursor = 0;
});
describe('outcome-first human review', () => {
  it('shows three concurrent agents working', () => {
    const ongoing = {
      ...snapshot,
      executions: ['calendar', 'navigation', 'search'].map((id) => ({
        id,
        run_id: run.id,
        role: 'coding',
        status: 'running',
        strategy: id,
      })),
    };
    const html = renderToStaticMarkup(
      createElement(AgentWorkSummary, { snapshot: ongoing, run, onInspect: noop }),
    );
    expect(html.match(/>Working<\/span>/g)).toHaveLength(3);
    expect(html).toContain('Agent progress is separate from independent checks and publication.');
  });
  it('enables the existing preview API for a checked full-stack app bundle without static deployment output', () => {
    const html = renderToStaticMarkup(
      createElement(CandidateOutcome, {
        repo: 'repo',
        candidate,
        evaluation: {
          ...snapshot.evaluations[0],
          deployment: undefined,
          app: { bundle_digest: 'bundle', revision: candidate.revision, policy_digest: 'policy' },
        },
        snapshot,
        run,
        onContext: noop,
        onGraph: noop,
      }),
    );
    expect(html).toContain('Preview website');
  });
  it('opens the results for inspection from the review banner without opening the publishing dialog', () => {
    find(render(), RunAttention)?.props.onAction('review', candidate.id);
    expect(hooks.states[0]).toBe('results');
    expect(find(render(), Dialog)).toBeUndefined();
  });
  it('starts with intent and outcome even while agents are working', () => {
    const working = {
      ...props,
      snapshot: {
        ...snapshot,
        candidates: [],
        evaluations: [],
        executions: [{ ...snapshot.executions[0], status: 'running' }],
      },
      run: { ...run, status: 'exploring' },
    };
    const html = renderToStaticMarkup(render(working));
    expect(hooks.states[0]).toBe('results');
    expect(html).toContain(run.intent);
    expect(html).toContain('Agents are working');
  });
  it('puts outcome preview and behavior checks before the decision/context story and optional diff', () => {
    const html = renderToStaticMarkup(render());
    expect(html).toContain('Outcome preview');
    expect(html).toContain('Behavior checks');
    expect(html).toContain('Accented events remain visible.');
    expect(html.indexOf('Outcome preview')).toBeLessThan(html.indexOf('Behavior checks'));
    expect(html.indexOf('Behavior checks')).toBeLessThan(html.indexOf('Decision and context'));
    expect(html).toContain('Use this result');
    expect(html).toContain('Inspect evidence graph');
  });
});
