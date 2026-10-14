import { expect, it } from 'vitest';
import { providerDefinition } from '../../shared/providers';
import { resolveAdaptiveApproval } from '../../cloudflare/worker/adaptive-approval';
import { prepareModelRequest } from '../../cloudflare/worker/model-policy';
import { normalizeReasoningEffort } from '../../cloudflare/worker/model-reasoning';
const connections = [
 {id:'managed-flash',provider:'mimo',model:'mimo-v2.6-flash',version:2,routing:null},
 {id:'personal-flash',provider:'mimo',model:'mimo-v2.6-flash',version:3,routing:null},
 {id:'saved-pro',provider:'mimo',model:'mimo-v2.6-pro',version:1,routing:{plan:'token_plan',region:'sgp'}},
];
  it('freezes an explicit saved connection into executable bounded Anthropic transport without a fallback', () => {
    for (const connection of [connections[0], connections[2]]) {
      const input = {
        adaptive_team: {
          version: 1,
          requested_agents: [{ connection: connection.id, role: 'builder' }],
        },
      };
      const approved = resolveAdaptiveApproval(input, connections);
      expect(approved.agents[0]).toMatchObject({
        connection: connection.id,
        provider: 'mimo',
        model: connection.model,
      });
      const model = providerDefinition('mimo').models.find(
        (model) => model.id === connection.model,
      );
      expect(model?.conservative_pricing).toBeDefined();
      const budget = {
        provider: 'mimo',
        model: connection.model,
        max_output_tokens: 4096,
        pricing: model?.conservative_pricing,
      };
      const job = {
        kind: 'agent',
        id: 'fixture',
        epoch: 1,
        model: connection.model,
        payload: {
          execution: {
            provider: 'mimo',
            harness: 'claude',
            connection: connection.id,
            run_id: 'fixture-run',
            routing: connection.routing,
          },
          run: { workspace_spend: { version: 1 }, model_budgets: [budget] },
        },
      };
      const prepared = prepareModelRequest(
        job,
        'claude',
        '/v1/messages',
        {
          model: 'wrong-model',
          max_tokens: 9000,
          messages: [{ role: 'user', content: 'offline fixture' }],
        },
        {
          owner: 'fixture-owner',
          repo_id: 'fixture-repo',
          run_id: 'fixture-run',
          job_id: 'fixture',
          epoch: 1,
          provider: 'mimo',
          model: connection.model,
          model_budget: structuredClone(budget),
        },
      );
      expect(prepared.body).toMatchObject({ model: connection.model, max_tokens: 4096 });
      expect(prepared.url).toBe(
        connection.routing?.plan === 'token_plan'
          ? 'https://token-plan-sgp.xiaomimimo.com/anthropic/v1/messages'
          : 'https://api.xiaomimimo.com/anthropic/v1/messages',
      );
    }
    expect(() =>
      resolveAdaptiveApproval(
        { adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'auto' }] } },
        connections,
      ),
    ).toThrow();
    expect(() =>
      resolveAdaptiveApproval(
        {
          adaptive_team: {
            version: 1,
            requested_agents: [{ connection: 'missing', role: 'builder' }],
          },
        },
        connections,
      ),
    ).toThrow();
  });


it('rejects invented MiMo reasoning controls without silently changing the frozen model', () => {
 for(const model of providerDefinition('mimo').models) {
  expect(normalizeReasoningEffort('mimo',model.id,undefined)).toBeUndefined();
  for(const effort of ['low','high','max','on','off']) expect(()=>normalizeReasoningEffort('mimo',model.id,effort)).toThrow();
 }
});
