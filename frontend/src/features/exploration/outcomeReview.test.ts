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
  onRetry: noop,
  onRepairTask: async () => true,
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
  it('shows three concurrent agents and their finite frozen coordination approval', () => {
    const approved = {
      ...run,
      autonomy_policy: {
        version: 1,
        enabled: true,
        max_repair_rounds: 2,
        max_concurrent_agents: 3,
        max_executions: 20,
        source_scope: 'project',
        allow_intent_questions: true,
      },
    };
    const ongoing = {
      ...snapshot,
      executions: ['calendar', 'navigation', 'coordinator'].map((id) => ({
        id,
        run_id: run.id,
        role: 'coding',
        status: 'running',
        strategy: id,
      })),
    };
    const html = renderToStaticMarkup(
      createElement(AgentWorkSummary, { snapshot: ongoing, run: approved, onInspect: noop }),
    );
    expect(html.match(/>Working<\/span>/g)).toHaveLength(3);
    expect(html).toContain('Frozen work approval');
    expect(html).toContain('3 agents concurrently');
    expect(html).toContain('20 executions');
    expect(html).toContain('2 repair rounds');
    expect(html).toContain('Publication requires a separate owner decision');
  });
  it('surfaces the recorded intent question while coordinating agents await an answer', () => {
    const input = {
      ...props,
      run: {
        ...run,
        status: 'awaiting_intent',
        intent_question: {
          id: 'question',
          run_id: run.id,
          status: 'pending',
          question: 'Should calendar access remain anonymous?',
          options: ['Keep anonymous access', 'Require sign-in'],
        },
      },
    };
    const html = renderToStaticMarkup(render(input));
    expect(html).toContain('Should calendar access remain anonymous?');
    expect(html).toContain('Keep anonymous access');
    expect(html).toContain('Record intent answer');
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
    expect(html).toContain('Record publishing decision');
    expect(html).toContain('Inspect evidence graph');
  });
  it('summarizes active repair and dependency blocks in the default review without implying failed parallel work stopped', () => {
    const input = {
      ...props,
      run: { ...run, mode: 'collaborate', team_repair_rounds: 1 },
      snapshot: {
        ...snapshot,
        candidates: [],
        evaluations: [],
        executions: [
          {
            id: 'repair',
            run_id: run.id,
            role: 'coding',
            status: 'running',
            strategy: 'Calendar repair',
          },
        ],
        team_tasks: [
          {
            task_id: 'calendar',
            run_id: run.id,
            title: 'Fix calendar',
            execution_id: 'repair',
            status: 'running',
            revision: 2,
          },
          {
            task_id: 'navigation',
            run_id: run.id,
            title: 'Update navigation',
            status: 'blocked',
            depends_on: ['calendar'],
          },
        ],
      },
    };
    const html = renderToStaticMarkup(render(input));
    expect(html).toContain('Agent work');
    expect(html).toContain('Repairing');
    expect(html).toContain('Waiting for Fix calendar');
  });
});
