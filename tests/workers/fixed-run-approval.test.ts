import { expect, it } from 'vitest';
import { resolveFixedApproval } from '../../cloudflare/worker/fixed-run-approval';

const connections = [{ id: 'personal-codex', provider: 'codex', model: 'gpt-5.6-luna', version: 3 }];
const request = { agents: [{ connection: 'personal-codex', provider: 'codex', model: 'gpt-5.6-luna', strategy: 'Keep my exact role' }] };

it('meters fixed clients while retaining exact saved model, strategy and tighter approved bounds', () => {
  const approved = resolveFixedApproval({ ...request, model_budgets: [{ provider: 'codex', model: 'gpt-5.6-luna', max_requests: 2, max_output_tokens: 512, max_execution_ms: 60000, spend_limit_microusd: 100000 }] }, connections, 50000000);
  expect(approved._workspace_spend).toBe(true);
  expect(approved.adaptive_team).toBeUndefined();
  expect(approved.agents[0]).toMatchObject({ connection: 'personal-codex', model: 'gpt-5.6-luna', strategy: 'Keep my exact role' });
  expect(approved.model_budgets[0]).toMatchObject({ max_requests: 2, max_output_tokens: 512, max_execution_ms: 60000, spend_limit_microusd: 100000 });
});

it('never expands trusted output, execution, request or shared spend ceilings', () => {
  const approved = resolveFixedApproval({ ...request, model_budgets: [{ provider: 'codex', model: 'gpt-5.6-luna', max_requests: 999, max_output_tokens: 999999, max_execution_ms: 999999, spend_limit_microusd: 999999999 }] }, connections, 50000000);
  expect(approved.model_budgets[0]).toMatchObject({ max_requests: 144, max_output_tokens: 4096, max_execution_ms: 600000, spend_limit_microusd: 50000000 });
});

it.each([
  { max_requests: -1 }, { max_output_tokens: 0 }, { max_execution_ms: '5000' },
  { spend_limit_microusd: 1.5 }, { pricing: { input_microusd_per_million: -1 } },
])('rejects malformed budget values before activating funding: %j', (fields) => {
  expect(() => resolveFixedApproval({ ...request, model_budgets: [{ provider: 'codex', model: 'gpt-5.6-luna', ...fields }] }, connections, 50000000)).toThrow();
});

it('rejects extra, duplicate or missing budget groups and changed saved models', () => {
  for (const budgets of [[], [{ provider: 'zai', model: 'glm-5.3-flash' }], [{ provider: 'codex', model: 'gpt-5.6-luna' }, { provider: 'codex', model: 'gpt-5.6-luna' }]]) {
    expect(() => resolveFixedApproval({ ...request, model_budgets: budgets }, connections, 50000000)).toThrow();
  }
  expect(() => resolveFixedApproval({ agents: [{ ...request.agents[0], model: 'changed-model' }] }, connections, 50000000)).toThrow();
});
