import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { runSamples } from '../../../../shared/run-samples';
import type { Snapshot } from '../../lib/types';
import type { Provider } from '../workspace/ProviderSettings';
import { AgentRoster } from './AgentRoster';
import { runAgentLimits } from './agentLimits';
import { Exploration } from './Exploration';
import { RunComposer } from './RunComposer';
import { RunToolbar } from './RunToolbar';
import { defaultConnections, runDraft } from './runDraft';
import { sampleBrief } from './sampleBrief';

const snapshot = {
  repository: { id: 'repo', status: 'ready', policy: { build: { setup: [], checks: [] } } },
  capabilities: { collaborative_runs: 1, team_planning: 1 },
  runs: [],
  executions: [],
  candidates: [],
  evaluations: [],
  decisions: [],
  nodes: [],
  edges: [],
} as unknown as Snapshot;
const providers = [
  { id: 'saved', provider: 'codex', model: 'recorded', label: 'Saved model' },
] as Provider[];
const noop = () => {};
function find(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, any>>) => boolean,
): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const element = node as ReactElement<Record<string, any>>;
  return predicate(element) ? element : find(element.props.children, predicate);
}
describe('ordinary Start a Run', () => {
  it('renders a primary empty-card start action with the toolbar prerequisites and no local setup', () => {
    for (const repository of [
      { ...snapshot.repository, pending: null },
      { ...snapshot.repository, pending: 'initializing' },
      { ...snapshot.repository, status: 'initializing', pending: null },
    ]) {
      const html = renderToStaticMarkup(
        createElement(Exploration, {
          snapshot: { ...snapshot, repository },
          onChange: async () => {},
          onError: noop,
          onProviders: noop,
          onAgents: noop,
          onContext: noop,
          onSelectedRun: noop,
        }),
      );
      const card = html.match(/<div class="empty-run">(.*?)<\/div>/s)?.[1] ?? '';
      expect(card).toContain('Describe what to build, a feature to add, or a bug to fix.');
      expect(card).toContain('Start a Run</button>');
      expect(card).not.toContain('class="quiet"');
      expect(card).not.toContain('Connect local agent');
      expect(card.includes('disabled=""')).toBe(
        repository.status !== 'ready' || !!repository.pending,
      );
    }
  });
  it('does not activate a prior manual team plan when starting fresh work after publication', () => {
    const plan = {
      version: 1,
      contract: 'Old contract',
      integrator_agent: 1,
      integration_paths: ['src/'],
      tasks: [],
    };
    const published = {
      ...snapshot,
      repository: { ...snapshot.repository, published_commit: 'published' },
      runs: [{ id: 'old', mode: 'collaborate', criteria: ['Keep persistence'], team_plan: plan }],
      candidates: [{ id: 'candidate', run_id: 'old', revision: { commit: 'published' } }],
      decisions: [
        {
          id: 'decision',
          run_id: 'old',
          candidate: 'candidate',
          status: 'published',
          target: { commit: 'published' },
        },
      ],
      artifacts: [],
    };
    const draft = runDraft(published);
    expect(draft.team).toBeUndefined();
    expect(draft.agents).toHaveLength(1);
    expect(draft.criteria).toContain('Keep persistence');
    expect(draft.previousTeamPlan).toEqual(plan);
  });
  it('starts blank with one automatic model and role, without resolving Auto in the browser', () => {
    const draft = runDraft(snapshot);
    expect(draft.intent).toBe('');
    expect(draft.mode).toBe('compare');
    expect(draft.agents).toHaveLength(1);
    expect(draft.agents[0]).toMatchObject({ connection: '', role: 'auto' });
    expect(defaultConnections(draft.agents, providers)[0].connection).toBe('');
  });
  it('keeps the main form simple and detailed settings in a closed Advanced section', () => {
    const html = renderToStaticMarkup(
      createElement(RunComposer, {
        snapshot,
        busy: false,
        onStart: async () => {},
        onClose: noop,
        onProviders: noop,
      }),
    );
    expect(html).toContain('aria-label="Start a run"');
    expect(html).toContain('Build new');
    expect(html).toContain('Add feature');
    expect(html).toContain('Fix bug');
    expect(html).toContain('Role for agent 1');
    expect(html).not.toContain('Role for agent 2');
    expect(html).toMatch(/<details[^>]*class="run-advanced"[^>]*><summary>Advanced<\/summary>/);
    expect(html.indexOf('Acceptance criteria')).toBeGreaterThan(html.indexOf('<summary>Advanced'));
    expect(html).not.toContain('Maximum spend');
    expect(html).toContain('Start a Run</button>');
  });
  it.each(runSamples)('shows the selected $label goal and task category in the form', (sample) => {
    const initial = sampleBrief(snapshot, undefined, sample);
    const html = renderToStaticMarkup(
      createElement(RunComposer, {
        snapshot,
        busy: false,
        initialRun: initial,
        sampleProfileId: sample.id,
        onStart: async () => {},
        onClose: noop,
        onProviders: noop,
      }),
    );
    expect(html).toContain(sample.summary);
    expect(html).toContain(sample.intent);
    expect(html).toContain(
      `aria-pressed="true"${sample.starter === 'bug' ? '>Fix bug' : '>Add feature'}`,
    );
  });
  it('adds an Auto seed and lets the owner assign a maintenance role', () => {
    let agents = runDraft(snapshot).agents;
    const render = () =>
      AgentRoster({
        agents,
        providers,
        loading: false,
        error: '',
        limits: runAgentLimits(snapshot),
        locked: false,
        onChange: (next) => {
          agents = next;
        },
        onProviders: noop,
        onRetry: noop,
      });
    find(
      render(),
      (element) => element.type === 'button' && element.props.children === 'Add agent',
    )?.props.onClick();
    expect(agents).toHaveLength(2);
    expect(agents[1]).toMatchObject({ connection: '', role: 'auto' });
    const role = find(render(), (element) => element.props['aria-label'] === 'Role for agent 2');
    expect(role).toBeDefined();
    role?.props.onChange({ target: { value: 'backend' } });
    expect(agents[1]).toMatchObject({ role: 'backend' });
    find(render(), (element) => element.props['aria-label'] === 'Remove agent 2')?.props.onClick();
    expect(agents).toHaveLength(1);
  });
  it('preserves frozen restart metadata and never mutates the historical arrays', () => {
    const source = {
      id: 'old',
      intent: 'Fix storage',
      criteria: ['Persist data'],
      context: ['context:storage'],
      agents: [
        {
          id: 'agent',
          connection: 'missing',
          strategy: 'Minimal',
          expectedModel: 'recorded',
          fromPreviousRun: true,
        },
      ],
      policy: '{}',
      budgets: {},
      mode: 'compare' as const,
    };
    const frozen = structuredClone(source);
    const draft = runDraft(snapshot, source);
    expect(defaultConnections(draft.agents, providers)[0].connection).toBe('missing');
    draft.agents[0].connection = 'saved';
    draft.context.push('context:new');
    expect(source).toEqual(frozen);
    expect(draft.mode).toBe('compare');
  });
  it('offers the same start action for an ordinary reviewer account', () => {
    expect(
      renderToStaticMarkup(
        createElement(RunToolbar, { snapshot, reviewer: true, canStart: true, onNewRun: noop }),
      ),
    ).toContain('Start a Run');
  });
});
