import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { providerDefinition } from '../../../../shared/providers';
import { AgentRoster } from '../exploration/AgentRoster';
import { modelPricingSuggestion } from '../exploration/modelBudgets';
import { AddProviderModel } from './AddProviderModel';
import type { Provider } from './ProviderSettings';
import { connectedModelGroups, modelReasoningEfforts } from './providerModels';

const connections: Provider[] = [
  {
    id: 'managed-flash',
    provider: 'mimo',
    model: 'mimo-v2.6-flash',
    label: 'Private managed key',
    version: 2,
  },
  {
    id: 'personal-flash',
    provider: 'mimo',
    model: 'mimo-v2.6-flash',
    label: 'Private BYOK key',
    version: 3,
  },
  {
    id: 'saved-pro',
    provider: 'mimo',
    model: 'mimo-v2.6-pro',
    label: 'Private Token Plan',
    version: 1,
    routing: { plan: 'token_plan', region: 'sgp' },
  },
];
const limits = {
  min_root_agents: 1,
  max_root_agents: 6,
  max_run_executions: 12,
  max_delegation_depth: 2,
  max_run_model_requests: 144,
};

describe('saved MiMo model execution choices', () => {
  it('renders actionable saved MiMo choices and preserves the explicitly selected funding identity', () => {
    const groups = connectedModelGroups(connections, 'personal-flash');
    expect(groups).toHaveLength(1);
    expect(groups[0].options.map(({ connection, disabled }) => [connection.id, disabled])).toEqual([
      ['personal-flash', false],
      ['saved-pro', false],
    ]);
    const html = renderToStaticMarkup(
      AgentRoster({
        agents: [{ id: 'a', connection: '', strategy: '', role: 'auto' }],
        providers: connections,
        limits,
        loading: false,
        error: '',
        locked: false,
        onChange: () => {},
        onProviders: () => {},
        onRetry: () => {},
      }),
    );
    expect(html).toContain('<optgroup label="MiMo">');
    expect(html).toContain('value="managed-flash">MiMo 2.6 Flash</option>');
    expect(html).toContain('value="saved-pro">MiMo 2.6 Pro</option>');
    for (const { label } of connections) expect(html).not.toContain(label);
    expect(connectedModelGroups([], '')).toEqual([]);
  });

  it('offers Pro using an existing saved MiMo key without requiring or exposing a new secret', () => {
    const html = renderToStaticMarkup(
      createElement(AddProviderModel, {
        source: connections[0],
        connections: [connections[0]],
        disabled: false,
        onSaved: async () => {},
        onCancel: () => {},
      }),
    );
    expect(html).toContain('value="mimo-v2.6-pro"');
    expect(html).not.toContain('value="mimo-v2.6-flash"');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain(connections[0].label);
    expect(html).not.toContain('mimo-v2.6-pro-ultraspeed');
  });

  it('keeps provider-default thinking and rejects unsupported explicit efforts rather than inventing levels', () => {
    for (const model of providerDefinition('mimo').models) {
      expect(modelReasoningEfforts('mimo', model.id)).toEqual([]);
      const suggestion = modelPricingSuggestion('mimo', model.id);
      expect(suggestion?.url).toBe('https://mimo.mi.com/docs/en-US/price/pay-as-you-go');
      expect(Number(suggestion?.input) * 1_000_000).toBe(
        model.conservative_pricing?.input_microusd_per_million,
      );
      expect(Number(suggestion?.output) * 1_000_000).toBe(
        model.conservative_pricing?.output_microusd_per_million,
      );
    }
  });
});
