import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Provider } from '../workspace/ProviderSettings';
import { AgentRoster } from './AgentRoster';
import type { AdaptiveAgentDraft } from './adaptiveDraft';

const providers: Provider[] = [
  {
    id: 'operator-funded',
    label: 'operator funding',
    provider: 'claude',
    model: 'claude-opus-5-5',
  },
  { id: 'personal', label: 'My private connection', provider: 'claude', model: 'claude-opus-5-5' },
  { id: 'sonnet', label: 'campaign connection', provider: 'claude', model: 'claude-sonnet-5-5' },
  { id: 'glm', label: 'owner campaign', provider: 'zai', model: 'glm-5.3-flash' },
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
  const element = node as ReactElement<Record<string, any>>;
  return element.props['aria-label'] === label ? element : find(element.props.children, label);
}
function roster(
  agents: AdaptiveAgentDraft[],
  onChange = (_: AdaptiveAgentDraft[]) => {},
  connections = providers,
) {
  return AgentRoster({
    agents,
    providers: connections,
    limits,
    loading: false,
    error: '',
    locked: false,
    onChange,
    onProviders: () => {},
    onRetry: () => {},
  });
}
describe('run model choices', () => {
  it('groups model names without exposing connection labels or repeating equivalent connections', () => {
    const html = renderToStaticMarkup(
      roster([{ id: 'a', connection: '', strategy: '', role: 'auto' }]),
    );
    expect(html).toContain('<optgroup label="Claude">');
    expect(html).toContain('<optgroup label="ZAI">');
    expect(html.match(/>Claude Opus 5.5<\/option>/g)).toHaveLength(1);
    expect(html).toContain('>Claude Sonnet 5.5</option>');
    expect(html).toContain('>GLM 5.3 Flash</option>');
    for (const connection of providers) expect(html).not.toContain(connection.label);
    expect(html).not.toContain('Preapproved');
    expect(html).not.toContain('Higher cost');
  });
  it('keeps the explicit selected duplicate connection instead of silently replacing its authority', () => {
    const html = renderToStaticMarkup(
      roster([
        {
          id: 'a',
          connection: 'personal',
          strategy: '',
          expectedProvider: 'claude',
          expectedModel: 'claude-opus-5-5',
          fromPreviousRun: true,
        },
      ]),
    );
    expect(html).toContain('value="personal" selected="">Claude Opus 5.5</option>');
    expect(html).not.toContain('value="operator-funded"');
  });
  it('lists only saved connections and retains an unavailable historical choice as disabled', () => {
    const html = renderToStaticMarkup(
      roster([{ id: 'a', connection: 'gone', strategy: '', fromPreviousRun: true }]),
    );
    expect(html).toContain('value="gone" disabled="" selected=""');
    expect(html).not.toContain('GPT 6.1 Sol');
    expect(html).not.toContain('Claude Haiku');
  });
  it('omits unpriced legacy models from fresh choices while keeping an explicitly pinned historical connection', () => {
    const connections = [
      ...providers,
      { id: 'legacy', label: 'Legacy key', provider: 'claude', model: 'claude-sonnet-4-6' },
    ];
    const fresh = renderToStaticMarkup(
      roster([{ id: 'a', connection: '', strategy: '' }], () => {}, connections),
    );
    expect(fresh).not.toContain('value="legacy"');
    const historical = renderToStaticMarkup(
      roster(
        [
          {
            id: 'a',
            connection: 'legacy',
            strategy: '',
            expectedProvider: 'claude',
            expectedModel: 'claude-sonnet-4-6',
            fromPreviousRun: true,
          },
        ],
        () => {},
        connections,
      ),
    );
    expect(historical).toContain(
      'value="legacy" disabled="" selected="">Claude Sonnet 4.6</option>',
    );
    expect(historical).toContain('role="alert"');
  });
  it('hides unpriced custom models from fresh choices but preserves the exact disabled historical ID', () => {
    const connections = [
      ...providers,
      { id: 'custom', label: 'Private origin', provider: 'codex', model: 'my-custom-model' },
    ];
    const fresh = renderToStaticMarkup(
      roster([{ id: 'a', connection: '', strategy: '' }], () => {}, connections),
    );
    expect(fresh).not.toContain('value="custom"');
    const historical = renderToStaticMarkup(
      roster(
        [
          {
            id: 'a',
            connection: 'custom',
            strategy: '',
            expectedProvider: 'codex',
            expectedModel: 'my-custom-model',
            fromPreviousRun: true,
          },
        ],
        () => {},
        connections,
      ),
    );
    expect(historical).toContain('value="custom" disabled="" selected="">my-custom-model</option>');
    expect(historical).toContain('role="alert"');
    expect(historical).not.toContain('Private origin');
  });
  it('selects the hidden connection ID without modifying the agent role or another seed', () => {
    let agents: AdaptiveAgentDraft[] = [
      { id: 'a', connection: 'personal', strategy: '', role: 'backend' },
      { id: 'b', connection: '', strategy: '', role: 'review' },
    ];
    find(
      roster(agents, (next) => {
        agents = next;
      }),
      'Model for agent 1',
    )?.props.onChange({ target: { value: 'glm' } });
    expect(agents[0]).toMatchObject({ connection: 'glm', role: 'backend', fromPreviousRun: false });
    expect(agents[1]).toMatchObject({ connection: '', role: 'review' });
  });
});
