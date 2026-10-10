import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { providerDefinition } from '../../shared/providers';
import { modelHandler } from '../../cloudflare/worker/models';
import { ledger } from '../../cloudflare/worker/storage';
import type { Json, Scope } from '../../cloudflare/worker/types';
import { seal } from '../../cloudflare/worker/vault';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, bindings, containerBindings, readyReviewer } from './reviewer-fixture';

afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

async function modelFixture(provider = 'codex') {
  const f = await readyReviewer();
  const definition = providerDefinition(provider);
  const model = definition.default_model;
  const connection = `test-${provider}`;
  const key = `synthetic-${provider}-upstream-key`;
  // Trusted setup extends funded fixtures to all five protocols; these are not
  // browser-configurable reviewer approvals. No provider network I/O occurs.
  await workspace(bindings, f.owner, { op: 'provider_put', provider, model, connection,
    sealed: await seal(f.scoped, f.owner, provider, key, connection) });
  await ledger(bindings, f.repo, { op: 'start_run', id: 'funded-model', intent: 'Synthetic provider accounting',
    agents: [{ provider, model, connection, strategy: 'Test charging' }],
    model_budgets: [{ provider, model, max_requests: 3, max_output_tokens: 512,
      max_execution_ms: 120000, spend_limit_microusd: 1_000_000,
      pricing: { input_microusd_per_million: 1_000_000, output_microusd_per_million: 5_000_000, source: 'owner-approved conservative rates' } }] });
  const job = await ledger(bindings, f.repo, { op: 'claim', job_id: 'job:funded-model:agent-1' });
  const scope: Scope = { repo_id: f.repo, job, supervisor: 'synthetic-supervisor', model_calls: 0, created_at: Date.now() };
  const container = containerBindings(f.scoped, scope);
  const harness = definition.harness;
  const path = harness === 'codex' ? '/v1/responses' : harness === 'gemini' ? `/v1beta/models/${model}:generateContent` : '/v1/messages';
  const request = () => new Request(`http://model.internal${path}`, { method: 'POST', body: JSON.stringify({
    messages: [{ role: 'user', content: 'Synthetic hello' }], input: 'Synthetic hello',
    contents: [{ role: 'user', parts: [{ text: 'Synthetic hello' }] }],
    max_tokens: 512, max_output_tokens: 512, generationConfig: { maxOutputTokens: 512 },
  }) });
  const call = async () => modelHandler(harness)(request(), container.scoped, { containerId: 'synthetic-container' } as Parameters<ReturnType<typeof modelHandler>>[2]);
  return { ...f, container, job, scope, key, harness, call };
}
function usageResponse(harness: string) {
  return harness === 'codex' ? { status: 'completed', usage: { input_tokens: 100, output_tokens: 10 } }
    : harness === 'gemini' ? { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } }
      : { type: 'message', usage: { input_tokens: 100, output_tokens: 10 } };
}

it.each(['codex', 'claude', 'mimo', 'zai', 'gemini'])('charges %s against the reviewer workspace using actual run reservations and settles fake upstream usage', async provider => {
  const f = await modelFixture(provider);
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const sent = new Promise<void>(resolve => { started = resolve; });
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect(new Headers(init.headers).get(providerDefinition(provider).auth_header)).toBe(providerDefinition(provider).auth_prefix + f.key);
    started(); await waiting;
    return Response.json(usageResponse(f.harness));
  });
  vi.stubGlobal('fetch', fetch);
  const pending = f.call();
  await Promise.race([sent, pending.then(response => { throw new Error(`Model rejected before fake upstream: HTTP ${response.status}`); })]);
  try {
    const run = (await ledger(bindings, f.repo, { op: 'snapshot' })).runs[0];
    const workspaceBudget = await workspace(bindings, f.owner, { op: 'budget_status' });
    expect(run.model_budgets[0].requests).toBe(1);
    expect(run.model_budgets[0].charged_microusd).toBeGreaterThan(0);
    expect(workspaceBudget.charged).toBe(run.model_budgets[0].charged_microusd);
    await evictDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${f.owner}`)));
  } finally { release(); }
  const response = await pending;
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain(f.key);
  expect(JSON.parse(body)).toEqual(usageResponse(f.harness));
  // $1/M input and $5/M output: 100 + 50 microdollars.
  expect((await workspace(bindings, f.owner, { op: 'budget_status' })).charged).toBe(150);
  expect((await ledger(bindings, f.repo, { op: 'snapshot' })).runs[0].model_budgets[0].charged_microusd).toBe(150);
  expect(fetch).toHaveBeenCalledOnce();
  expect((await workspace(bindings, '_budget_claude', { op: 'budget_status' })).charged).toBe(0);
});

it.each(['expired', 'revoked'])('rejects %s reviewer sessions, trials and inference before secrets or upstream access', async condition => {
  const f = await modelFixture();
  if (condition === 'revoked') {
    expect((await api(f.scoped, '/api/admin/reviewer/revoke', '', { username: f.owner }, true)).status).toBe(200);
  } else {
    // Deliberately simulate elapsed wall-clock in the real DO persisted policy.
    // Vitest's JS fake clock would not move the Rust authority's clock.
    const stub = bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${f.owner}`));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE workspace_records SET payload=json_set(payload,'$.expires',1) WHERE id='reviewer_policy'");
    });
  }
  const secrets = vi.fn(async () => { throw new Error('expired inference must not decrypt credentials'); });
  const realWorkspace = f.container.scoped.WORKSPACES;
  f.container.scoped.WORKSPACES = { idFromName: (name: string) => realWorkspace.idFromName(name),
    get: (id: DurableObjectId) => ({ fetch: async (url: string, options: RequestInit) => {
      if (JSON.parse(String(options.body)).op === 'provider_secret') return secrets();
      return realWorkspace.get(id).fetch(url, options);
    } }) } as unknown as typeof realWorkspace;
  const fetch = vi.fn(async () => Response.json(usageResponse('codex')));
  vi.stubGlobal('fetch', fetch);
  const response = await f.call();
  expect(response.status).toBe(409);
  expect((await response.json<Json>()).error.code).toBe('REVIEWER_EXPIRED');
  expect(secrets).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect((await api(f.scoped, '/api/reviewer', f.cookie)).status).toBe(401);
  expect((await api(f.scoped, '/api/reviewer/trial', f.cookie, { request_id: 'expired-trial-12345678' })).status).toBe(401);
  expect((await workspace(bindings, f.owner, { op: 'budget_status' })).charged).toBe(0);
  expect((await ledger(bindings, f.repo, { op: 'snapshot' })).runs[0].model_budgets[0].requests).toBe(0);
});

it('releases the unused run charge when a workspace is exhausted and sends no upstream request', async () => {
  const f = await modelFixture();
  for (const [id, amount] of [['first', 20_000_000], ['second', 20_000_000], ['last', 10_000_000]] as const)
    await workspace(bindings, f.owner, { op: 'budget_reserve', id, amount });
  const fetch = vi.fn(async () => Response.json(usageResponse('codex')));
  vi.stubGlobal('fetch', fetch);
  const response = await f.call();
  expect(response.status).toBe(409);
  expect((await response.json<Json>()).error.code).toBe('BUDGET_EXHAUSTED');
  expect(fetch).not.toHaveBeenCalled();
  const budget = (await ledger(bindings, f.repo, { op: 'snapshot' })).runs[0].model_budgets[0];
  expect(budget.requests).toBe(1);
  expect(budget.charged_microusd).toBe(0);
  expect((await workspace(bindings, f.owner, { op: 'budget_status' })).charged).toBe(50_000_000);
});

it('retains both durable reservations on simulated provider transport failure', async () => {
  const f = await modelFixture('claude');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Simulated upstream disconnect'); }));
  const response = await f.call();
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain(f.key);
  const charged = (await ledger(bindings, f.repo, { op: 'snapshot' })).runs[0].model_budgets[0].charged_microusd;
  expect(charged).toBeGreaterThan(0);
  expect((await workspace(bindings, f.owner, { op: 'budget_status' })).charged).toBe(charged);
});
