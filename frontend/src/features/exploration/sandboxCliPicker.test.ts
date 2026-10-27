import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import type { Provider } from '../workspace/ProviderSettings';
import { AgentRoster } from './AgentRoster';
import { type AdaptiveAgentDraft, requestedAgents } from './adaptiveDraft';
import { runtimeChoice } from './RunRuntimePicker';

const providers: Provider[] = [
  { id: 'glm', label: 'Z.ai', provider: 'zai', model: 'glm-5.3-flash' },
  { id: 'luna', label: 'OpenAI', provider: 'codex', model: 'gpt-5.6-luna' },
  { id: 'flash', label: 'Google', provider: 'gemini', model: 'gemini-3.8-flash' },
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
function roster(
  agent: AdaptiveAgentDraft,
  sandbox: boolean,
  change = (_: AdaptiveAgentDraft[]) => {},
) {
  return AgentRoster({
    agents: [agent],
    providers,
    limits,
    loading: false,
    error: '',
    locked: false,
    sandbox,
    onChange: change,
    onProviders: () => {},
    onRetry: () => {},
  });
}
const options = (select?: ReactElement<Record<string, any>>) =>
  ((select?.props.children ?? []) as ReactElement<Record<string, any>>[]).map((o) => o.props.value);

describe('sandbox coding CLI choice', () => {
  it('offers each agent the CLIs its model can run, defaulting by provider', () => {
    const cases: [string, string[], string][] = [
      ['glm', ['claude', 'opencode', 'mimo'], 'claude'],
      ['luna', ['codex', 'opencode', 'mimo'], 'codex'],
      ['flash', ['opencode', 'mimo'], 'opencode'],
    ];
    for (const [connection, clis, chosen] of cases) {
      const select = find(
        roster({ id: 'a', connection, strategy: '' }, true),
        'Coding CLI for agent 1',
      );
      expect(options(select)).toEqual(clis);
      expect(select?.props.value).toBe(chosen);
    }
    // Classic runs and Auto models show no choice.
    expect(
      renderToStaticMarkup(roster({ id: 'a', connection: 'glm', strategy: '' }, false)),
    ).not.toContain('Coding CLI');
    expect(
      renderToStaticMarkup(roster({ id: 'a', connection: '', strategy: '' }, true)),
    ).not.toContain('Coding CLI');
  });

  it('keeps a chosen CLI until the model changes', () => {
    let next: AdaptiveAgentDraft[] = [];
    const agent: AdaptiveAgentDraft = { id: 'a', connection: 'glm', strategy: '' };
    find(
      roster(agent, true, (v) => (next = v)),
      'Coding CLI for agent 1',
    )?.props.onChange({
      target: { value: 'opencode' },
    });
    expect(next[0].cli).toBe('opencode');
    find(
      roster(next[0], true, (v) => (next = v)),
      'Model for agent 1',
    )?.props.onChange({
      target: { value: 'luna' },
    });
    expect(next[0].cli).toBeUndefined();
  });

  it('sends the CLI only for a sandbox agent whose model it can run', () => {
    const agent: AdaptiveAgentDraft = { id: 'a', connection: 'glm', strategy: '', cli: 'opencode' };
    expect(requestedAgents([agent], providers, true)).toEqual([
      { connection: 'glm', role: 'auto', cli: 'opencode' },
    ]);
    expect(requestedAgents([agent], providers, false)).toEqual([
      { connection: 'glm', role: 'auto' },
    ]);
    expect(requestedAgents([{ ...agent, cli: 'codex' }], providers, true)).toEqual([
      { connection: 'glm', role: 'auto' },
    ]);
  });

  it('offers the sandbox for OpenAI and Google models now that a CLI runs them', () => {
    const snapshot = { capabilities: { sandbox_runtime: 'sandbox-cli-v1' } } as unknown as Snapshot;
    const agents = providers.map((p) => ({ id: p.id, connection: p.id, strategy: '' }));
    expect(runtimeChoice(snapshot, 'sandbox', agents, providers)).toMatchObject({
      sandbox: true,
      blocker: undefined,
    });
  });
});
