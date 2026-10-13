import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { providers as catalog } from '../../../../shared/providers';
import type { Snapshot } from '../../lib/types';
import type { Provider } from '../workspace/ProviderSettings';
import { AgentRoster } from './AgentRoster';
import { type AdaptiveAgentDraft, requestedAgents } from './adaptiveDraft';
import { initialRun } from './restartRun';

const model = catalog.find((p) => p.id === 'codex')?.models.find((m) => m.id === 'gpt-6.1-sol');
const providers: Provider[] = [
  { id: 'sol', label: 'operator subscription', provider: 'codex', model: 'gpt-6.1-sol' },
  { id: 'custom', label: 'private key', provider: 'codex', model: 'custom-model' },
];
const limits = {
  min_root_agents: 1,
  max_root_agents: 6,
  max_run_executions: 12,
  max_delegation_depth: 2,
  max_run_model_requests: 144,
};
function find(node: ReactNode, label: string): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, label)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement<Record<string, any>>;
  return el.props['aria-label'] === label ? el : find(el.props.children, label);
}
function roster(agent: AdaptiveAgentDraft, change = (_: AdaptiveAgentDraft[]) => {}) {
  return AgentRoster({
    agents: [agent],
    providers,
    limits,
    loading: false,
    error: '',
    locked: false,
    onChange: change,
    onProviders: () => {},
    onRetry: () => {},
  });
}
describe('explicit reasoning preferences', () => {
  it('offers only the selected model catalog levels plus Auto, and hides reasoning for Auto/custom models', () => {
    expect(model?.reasoning_efforts?.length).toBeGreaterThan(0);
    const agent = { id: 'a', connection: 'sol', strategy: '' };
    const select = find(roster(agent), 'Reasoning for agent 1');
    expect(select).toBeDefined();
    const options = ((select?.props.children ?? []) as ReactElement<Record<string, any>>[])
      .flat()
      .filter(Boolean);
    expect(options.map((o) => o.props.value)).toEqual(['', ...(model?.reasoning_efforts ?? [])]);
    for (const connection of ['', 'custom'])
      expect(renderToStaticMarkup(roster({ ...agent, connection }))).not.toContain(
        'Reasoning for agent 1',
      );
  });
  it('carries an explicit catalog effort as a preference but omits Auto and model authority', () => {
    const agent = {
      id: 'a',
      connection: 'sol',
      strategy: '',
      role: 'backend' as const,
      reasoning_effort: 'high',
    };
    expect(requestedAgents([agent], providers)).toEqual([
      { connection: 'sol', role: 'backend', reasoning_effort: 'high' },
    ]);
    expect(requestedAgents([{ ...agent, reasoning_effort: undefined }], providers)).toEqual([
      { connection: 'sol', role: 'backend' },
    ]);
    expect(
      requestedAgents([{ ...agent, connection: '', reasoning_effort: undefined }], providers),
    ).toEqual([{ connection: null, role: 'backend' }]);
  });
  it('fences unsupported or unbound explicit effort rather than silently replacing it', () => {
    const agent = { id: 'a', connection: 'sol', strategy: '', reasoning_effort: 'none' };
    expect(() => requestedAgents([agent], providers)).toThrow(/reasoning/i);
    expect(() =>
      requestedAgents([{ ...agent, connection: '', reasoning_effort: 'high' }], providers),
    ).toThrow(/reasoning/i);
    expect(() =>
      requestedAgents([{ ...agent, connection: 'custom', reasoning_effort: 'high' }], providers),
    ).toThrow(/reasoning/i);
    expect(() => requestedAgents([{ ...agent, reasoning_effort: 'auto' }], providers)).toThrow(
      /reasoning/i,
    );
  });
  it('uses GLM effort levels without offering unsupported OpenAI none or Extra high choices', () => {
    const connections = [{ id: 'glm', provider: 'zai', model: 'glm-5.3-flash' }];
    const agent = { id: 'a', connection: 'glm', strategy: '', reasoning_effort: 'high' };
    expect(requestedAgents([agent], connections)[0].reasoning_effort).toBe('high');
    for (const reasoning_effort of ['none', 'medium', 'xhigh', 'off'])
      expect(() => requestedAgents([{ ...agent, reasoning_effort }], connections)).toThrow(
        /reasoning/i,
      );
  });
  it('retains an unsupported historical effort visibly until the owner explicitly chooses Auto', () => {
    let agent: AdaptiveAgentDraft = {
      id: 'a',
      connection: 'sol',
      strategy: '',
      reasoning_effort: 'none',
    };
    const html = renderToStaticMarkup(roster(agent));
    expect(html).toContain('Previous setting (unavailable)');
    expect(html).toContain('role="alert"');
    find(
      roster(agent, (next) => {
        agent = next[0];
      }),
      'Reasoning for agent 1',
    )?.props.onChange({ target: { value: '' } });
    expect(requestedAgents([agent], providers)[0]).not.toHaveProperty('reasoning_effort');
  });
  it('clears effort on model change, keeps the role, and locks reasoning on an uncertain request', () => {
    let agent: AdaptiveAgentDraft = {
      id: 'a',
      connection: 'sol',
      strategy: '',
      role: 'review',
      reasoning_effort: 'high',
    };
    find(
      roster(agent, (next) => {
        agent = next[0];
      }),
      'Model for agent 1',
    )?.props.onChange({ target: { value: 'custom' } });
    expect(agent).toMatchObject({
      connection: 'custom',
      role: 'review',
      reasoning_effort: undefined,
    });
    const tree = AgentRoster({
      agents: [{ ...agent, connection: 'sol' }],
      providers,
      limits,
      loading: false,
      error: '',
      locked: true,
      onChange: () => {},
      onProviders: () => {},
      onRetry: () => {},
    });
    expect(find(tree, 'Reasoning for agent 1')?.props.disabled).toBe(true);
  });
  it('restores the exact frozen effort in both collaborative and compare restarts', () => {
    const snapshot = {
      repository: { policy: { build: {} } },
      executions: [
        {
          run_id: 'old',
          role: 'coding',
          connection: 'sol',
          provider: 'codex',
          model: 'gpt-6.1-sol',
          reasoning_effort: 'max',
        },
      ],
    } as unknown as Snapshot;
    for (const mode of ['collaborate', 'compare']) {
      const run = {
        id: 'old',
        mode,
        agents: [
          { connection: 'sol', provider: 'codex', model: 'gpt-6.1-sol', reasoning_effort: 'max' },
        ],
      };
      expect(initialRun(snapshot, run).agents[0]).toMatchObject({
        connection: 'sol',
        reasoning_effort: 'max',
      });
      expect(run.agents[0].reasoning_effort).toBe('max');
    }
  });
});
