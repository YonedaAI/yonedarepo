import { env } from 'cloudflare:workers';
import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { prepareModelRequest } from '../../cloudflare/worker/model-policy';
import { trackProviderUsage } from '../../cloudflare/worker/provider-usage';
import { checkLedger, checkRuntime } from '../../cloudflare/worker/runtime';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
afterEach(async () => { await reset(); });
const budget = {
  provider: 'zai', model: 'glm-4.7-flash', max_requests: 3,
  max_output_tokens: 512, max_execution_ms: 120000,
  spend_limit_microusd: 1000000,
  pricing: { input_microusd_per_million: 1000000,
    output_microusd_per_million: 5000000, source: 'owner-approved conservative rates' },
};

it('fences longer execution limits during ledger and image rollout', () => {
  const request = { model_budgets: [{ ...budget, max_execution_ms: 1800000 }] };
  const capabilities = { artifact_reads: 2, model_budgets: 1 };
  expect(() => checkLedger({ capabilities }, request)).toThrow('updating');
  expect(() => checkLedger({ capabilities: { ...capabilities, max_execution_ms: 1800000 } }, request)).not.toThrow();
  const job = { kind: 'agent', payload: { run: request } };
  expect(() => checkRuntime({ protocol: 2, capabilities }, job)).toThrow('execution time');
  expect(() => checkRuntime({ protocol: 2, capabilities: { ...capabilities, max_execution_ms: 1800000 } }, job)).not.toThrow();
});

it('caps all five model protocols at the approved response allowance and fails closed on missing approval', () => {
  for (const provider of ['claude', 'mimo', 'zai', 'codex', 'gemini']) {
    const harness = ['codex', 'gemini'].includes(provider) ? provider : 'claude';
    const model = provider === 'claude' ? 'claude-sonnet-4-6' : 'test-model';
    const job = { kind: 'agent', model, payload: { execution: { provider, harness }, run: {
      model_budgets: [{ ...budget, provider, model }],
    } } };
    const path = harness === 'codex' ? '/v1/responses' : harness === 'gemini'
      ? '/v1beta/models/test-model:generateContent' : '/v1/messages';
    const body = prepareModelRequest(job, harness as 'claude' | 'codex' | 'gemini', path, {
      max_tokens: 99999, max_output_tokens: 99999, generationConfig: { maxOutputTokens: 99999 },
    }).body;
    expect(harness === 'codex' ? body.max_output_tokens : harness === 'gemini'
      ? body.generationConfig.maxOutputTokens : body.max_tokens).toBe(512);
    job.payload.run.model_budgets = [];
    expect(() => prepareModelRequest(job, harness as 'claude' | 'codex' | 'gemini', path, {})).toThrow('budget');
  }
});

it('blocks approved budgets on older ledgers and container images before inference', () => {
  const request = { model_budgets: [budget] };
  expect(() => checkLedger({ capabilities: { artifact_reads: 2 } }, request)).toThrow('updating');
  expect(() => checkLedger({ capabilities: { artifact_reads: 2 } }, { restart_of: 'previous' })).toThrow('updating');
  expect(() => checkLedger({ capabilities: { artifact_reads: 2, model_budgets: 1 } }, request)).not.toThrow();
  const job = { kind: 'agent', payload: { run: request } };
  expect(() => checkRuntime({ protocol: 2 }, job)).toThrow('budgets');
  expect(() => checkRuntime({ protocol: 2, capabilities: { model_budgets: 1 } }, job)).not.toThrow();
  const uncapped = { model_budgets: [{ ...budget, max_requests: null }] };
  expect(() => checkLedger({ capabilities: { artifact_reads: 2, model_budgets: 1 } }, uncapped)).toThrow('updating');
  expect(() => checkLedger({ capabilities: { artifact_reads: 2, model_budgets: 1, optional_model_requests: 1 } }, uncapped)).not.toThrow();
  expect(() => checkRuntime({ protocol: 2, capabilities: { model_budgets: 1 } }, { kind: 'agent', payload: { run: uncapped } })).toThrow('optional');
});

it('reconciles provider usage including caches and reasoning without changing the response', async () => {
  const cases: ['claude' | 'codex' | 'gemini', string, object][] = [
    ['claude', 'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":5}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\ndata: {"type":"message_stop"}\n\n', { input_tokens: 35, output_tokens: 7 }],
    ['codex', 'data: {"type":"response.completed","response":{"usage":{"input_tokens":40,"output_tokens":21}}}\n\ndata: [DONE]\n\n', { input_tokens: 40, output_tokens: 21 }],
    ['gemini', 'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":18,"candidatesTokenCount":9,"thoughtsTokenCount":6}}\n\n', { input_tokens: 18, output_tokens: 15 }],
  ];
  for (const [harness, content, expected] of cases) {
    const observed: object[] = [];
    const response = trackProviderUsage(new Response(content, { headers: { 'content-type': 'text/event-stream' } }), harness, async value => { observed.push(value); });
    expect(await response.text()).toBe(content);
    expect(observed).toEqual([expected]);
  }
});

it('retains unknown, partial, invalid and failed provider reservations', async () => {
  let settled = 0;
  for (const content of [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":-1,"output_tokens":0}}}\n\ndata: {"type":"message_stop"}\n\n',
    'data: invalid\n\ndata: {"type":"message","usage":{"input_tokens":1,"output_tokens":1}}\n\n',
  ]) {
    await trackProviderUsage(new Response(content, { headers: { 'content-type': 'text/event-stream' } }), 'claude', async () => { settled++; }).text();
  }
  await trackProviderUsage(Response.json({ error: 'provider failure' }, { status: 402 }), 'claude', async () => { settled++; }).text();
  expect(settled).toBe(0);
});

it('shares real DO reservations across roots and eviction and settles an upstream response once', async () => {
  const repo = 'budget-integration';
  const call = (command: Json) => ledger(bindings, repo, command);
  await call({ op: 'init', id: repo, name: 'Budget fixture', commit: 'a'.repeat(40),
    remote: { namespace: 'test', name: repo }, policy: {
      version: 'budget-v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1',
      required_checks: ['syntax'], build: { setup: [], checks: [{ name: 'syntax', argv: ['node', '--check', 'app.js'], timeout_seconds: 30 }] },
    } });
  await call({ op: 'start_run', id: 'budgeted', intent: 'Local budget verification',
    agents: ['first', 'second'].map(strategy => ({ provider: budget.provider, model: budget.model, strategy })),
    model_budgets: [budget] });
  const jobs = await Promise.all([1, 2].map(index => call({ op: 'claim', job_id: `job:budgeted:agent-${index}` })));
  const reserve = (job: Json) => call({ op: 'reserve_request', job_id: job.id, epoch: job.epoch,
    kind: 'model', input_bytes: 100, output_tokens: 512 });
  const reservation = await reserve(jobs[0]);
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)));
  const settle = (usage: Json) => call({ op: 'settle_model_request', job_id: jobs[0].id,
    epoch: jobs[0].epoch, reservation_id: reservation.reservation_id, ...usage });
  const upstream = { type: 'message', usage: { input_tokens: 100, output_tokens: 10 } };
  await trackProviderUsage(Response.json(upstream), 'claude', settle).text();
  await settle({ input_tokens: 100, output_tokens: 10 });
  await reserve(jobs[1]);
  await reserve(jobs[0]);
  const before = await call({ op: 'snapshot' });
  expect(before.runs[0].model_budgets[0].requests).toBe(3);
  expect(before.runs[0].model_budgets[0].charged_microusd).toBeLessThan(3 * reservation.reservation_microusd);
  await expect(reserve(jobs[1])).rejects.toMatchObject({ code: 'MODEL_REQUEST_LIMIT' });
  expect((await call({ op: 'snapshot' })).runs[0].model_budgets).toEqual(before.runs[0].model_budgets);
});
