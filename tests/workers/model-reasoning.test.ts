import { expect, it } from 'vitest';
import { providerDefinition } from '../../shared/providers';
import { resolveAdaptiveApproval } from '../../cloudflare/worker/adaptive-approval';
import { resolveFixedApproval } from '../../cloudflare/worker/fixed-run-approval';
import { prepareModelRequest } from '../../cloudflare/worker/model-policy';
import type { Json } from '../../cloudflare/worker/types';
import type { WorkspaceSpendContext } from '../../cloudflare/worker/workspace-spend';

const connections = [{ id: 'luna', provider: 'codex', model: 'gpt-5.6-luna', version: 1 }];
const request = (effort: unknown) => ({ adaptive_team: { version: 1, requested_agents: [{ connection: 'luna', role: 'builder', reasoning_effort: effort }] } });

it('freezes supported explicit effort in seed, requested intent and registry-derived support pool', () => {
  const approved = resolveAdaptiveApproval(request('high'), connections);
  expect(approved.agents[0].reasoning_effort).toBe('high');
  expect(approved.adaptive_team.requested_agents[0].reasoning_effort).toBe('high');
  expect(approved._approved_model_pool[0].reasoning_efforts).toContain('high');
  for (const value of ['unsupported', 'auto', true, 1]) expect(() => resolveAdaptiveApproval(request(value), connections)).toThrow();
  expect(resolveAdaptiveApproval(request(null), connections).agents[0].reasoning_effort).toBeUndefined();
});

it('retains effort on fixed approvals and restricts Auto seeds without disabling explicit catalog models', () => {
  const fixed = resolveFixedApproval({ agents: [{ connection: 'luna', provider: 'codex', model: 'gpt-5.6-luna', strategy: 'Fixed', reasoning_effort: 'low' }] }, connections, 50000000);
  expect(fixed.agents[0].reasoning_effort).toBe('low');
  const modern = [{ id: 'sol', provider: 'codex', model: 'gpt-6.1-sol', version: 1 }];
  expect(() => resolveAdaptiveApproval({ adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'auto' }] } }, modern)).toThrow();
  expect(resolveAdaptiveApproval({ adaptive_team: { version: 1, requested_agents: [{ connection: 'sol', role: 'builder', reasoning_effort: 'max' }] } }, modern).agents[0]).toMatchObject({ connection: 'sol', reasoning_effort: 'max' });
  expect(() => resolveAdaptiveApproval({ adaptive_team: { version: 1, requested_agents: [{ connection: 'sol', role: 'builder', reasoning_effort: 'none' }] } }, modern)).toThrow();
});

function job(provider: string, model: string, effort?: unknown): Json {
  return { kind: 'agent', model, payload: { execution: { provider, harness: provider === 'codex' ? 'codex' : 'claude', ...(effort === undefined ? {} : { reasoning_effort: effort }) }, run: { model_budgets: [{ provider, model, max_output_tokens: 4096 }] } } };
}

it('forces Codex effort from the frozen execution instead of request-body escalation', () => {
  const input = { reasoning: { effort: 'max', summary: 'auto' }, max_output_tokens: 999999 };
  const result = prepareModelRequest(job('codex', 'gpt-5.6-luna', 'low'), 'codex', '/v1/responses', input);
  expect(result.body.reasoning.effort).toBe('low');
  expect(result.body.max_output_tokens).toBe(4096);
  expect(input.reasoning.effort).toBe('max');
  expect(() => prepareModelRequest(job('codex', 'gpt-6.1-sol', 'none'), 'codex', '/v1/responses', {})).toThrow();
});

it('forces Claude effort and adaptive thinking while keeping legacy absent-effort behavior and the Opus fence', () => {
  const result = prepareModelRequest(job('claude', 'claude-sonnet-5-5', 'max'), 'claude', '/v1/messages', { output_config: { effort: 'low' }, thinking: { type: 'disabled' } });
  expect(result.body.output_config.effort).toBe('max');
  expect(result.body.thinking.type).toBe('adaptive');
  const legacy = prepareModelRequest(job('claude', 'claude-sonnet-5-5'), 'claude', '/v1/messages', { output_config: { effort: 'low' }, thinking: { type: 'disabled' } });
  expect(legacy.body.thinking.type).toBe('between_tools');
  expect(legacy.body.output_config.effort).toBe('low');
  expect(() => prepareModelRequest(job('claude', 'claude-opus-5-5', 'max'), 'claude', '/v1/messages', {})).toThrow('workspace-approved');
});

it('forces documented GLM effort without exposing an unsupported off switch', () => {
  const result = prepareModelRequest(job('zai', 'glm-5.3-flash', 'high'), 'claude', '/v1/messages', { output_config: { effort: 'low' }, thinking: { type: 'disabled' } });
  expect(result.body.output_config.effort).toBe('high');
  expect(result.body.thinking.type).toBe('enabled');
  expect(() => prepareModelRequest(job('zai', 'glm-5.3-flash', 'off'), 'claude', '/v1/messages', {})).toThrow();
});

function sharedJob(provider: string, model: string, effort: string) {
  const attempt = job(provider, model, effort);
  attempt.id = 'job:effort';
  attempt.epoch = 1;
  attempt.payload.execution.run_id = 'run:effort';
  attempt.payload.run.workspace_spend = { version: 1 };
  const budget = attempt.payload.run.model_budgets[0];
  budget.pricing = providerDefinition(provider).models.find((entry) => entry.id === model)?.conservative_pricing;
  expect(budget.pricing).toBeDefined();
  const context: WorkspaceSpendContext = {
    owner: 'owner', repo_id: 'repo', run_id: 'run:effort', job_id: attempt.id,
    epoch: 1, provider, model, model_budget: structuredClone(budget),
  };
  return { attempt, context };
}

it('accepts priced shared Haiku transport with frozen effort and unchanged output cap', () => {
  for (const effort of ['low', 'max']) {
    const { attempt, context } = sharedJob('claude', 'claude-haiku-5-5', effort);
    const result = prepareModelRequest(attempt, 'claude', '/v1/messages', {
      messages: [{ role: 'user', content: 'bounded fixture' }],
      max_tokens: 9000, output_config: { effort: 'medium' },
      thinking: { type: 'enabled', budget_tokens: 10000, display: 'updates' },
    }, context);
    expect(result.body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 4096, output_config: { effort }, thinking: { type: 'adaptive', display: 'summarized' } });
    expect(result.body.thinking.budget_tokens).toBeUndefined();
    expect(result.reservation).toBe(0); // Native shared allocation, no legacy static-rate lookup.
    const drift = structuredClone(context);
    drift.model_budget.max_output_tokens = 8192;
    expect(() => prepareModelRequest(attempt, 'claude', '/v1/messages', {}, drift)).toThrow('frozen attempt');
    expect(() => prepareModelRequest(attempt, 'claude', '/v1/messages', {})).toThrow();
  }
});

it('clamps modern Sol transport to the frozen effort and exact shared approval', () => {
  const { attempt, context } = sharedJob('codex', 'gpt-6.1-sol', 'high');
  const result = prepareModelRequest(attempt, 'codex', '/v1/responses', {
    input: [{ role: 'user', content: 'bounded fixture' }],
    reasoning: { effort: 'max', summary: 'auto' }, max_output_tokens: 9000,
    store: true, service_tier: 'priority', speed: 'fast',
  }, context);
  expect(result.body).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'high', summary: 'auto' }, max_output_tokens: 4096, store: false });
  expect(result.body.service_tier).toBeUndefined();
  expect(result.body.speed).toBeUndefined();
  expect(() => prepareModelRequest(attempt, 'codex', '/v1/responses', {}, { ...context, epoch: 2 })).toThrow('frozen attempt');
});

it('excludes manual-only models from an Auto planner pool until explicitly selected', () => {
  const pool = [...connections, { id: 'new-sol', provider: 'codex', model: 'gpt-6.1-sol', version: 1 }];
  const auto = resolveAdaptiveApproval({ adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'auto' }] } }, pool);
  expect(auto._approved_model_pool.map((entry: Json) => entry.connection)).toEqual(['luna']);
  const explicit = resolveAdaptiveApproval({ adaptive_team: { version: 1, requested_agents: [{ connection: 'new-sol', role: 'builder', reasoning_effort: 'low' }] } }, pool);
  expect(explicit._approved_model_pool.map((entry: Json) => entry.connection)).toContain('new-sol');
});

it('runs GLM at low effort when no effort was chosen, instead of the provider maximum', () => {
  const result = prepareModelRequest(job('zai', 'glm-5.3-flash'), 'claude', '/v1/messages', { output_config: { effort: 'max' } });
  expect(result.body.output_config.effort).toBe('low');
  const chosen = prepareModelRequest(job('zai', 'glm-5.3-flash', 'high'), 'claude', '/v1/messages', {});
  expect(chosen.body.output_config.effort).toBe('high');
});
