import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { modelHandler } from '../../cloudflare/worker/models';
import { campaignModelBudgets } from '../../cloudflare/worker/reviewer-campaign';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { seal } from '../../cloudflare/worker/vault';
import { workspace } from '../../cloudflare/worker/workspace';
import { workspaceSpendConfigure, workspaceSpendStatus } from '../../cloudflare/worker/workspace-spend';
import { bindings, containerBindings, readyReviewer } from './reviewer-fixture';
import { approvedLedger } from './source-kit';

afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
async function fixture(marked = true) {
  const f = await readyReviewer();
  const connection = 'explicit-owner-opus';
  const budget = { ...campaignModelBudgets[3], max_requests: 3, max_output_tokens: 4096,
    max_execution_ms: 120000, spend_limit_microusd: 50000000 };
  await workspace(bindings, f.owner, { op: 'provider_put', provider: 'claude', model: budget.model,
    connection, sealed: await seal(f.scoped, f.owner, 'claude', 'synthetic-opus-key', connection) });
  if (marked) await workspaceSpendConfigure(bindings, f.owner, 0, 50000000);
  await approvedLedger(bindings, f.repo)({ op: 'start_run', id: 'explicit-opus', _workspace: f.owner,
    ...(marked ? { _workspace_spend: true } : {}), intent: 'Explicit owner-approved difficult task',
    agents: [{ provider: 'claude', model: budget.model, connection, strategy: 'Explicit choice' }], model_budgets: [budget] });
  const job = await ledger(bindings, f.repo, { op: 'claim', job_id: 'job:explicit-opus:agent-1' });
  const scope: Scope = { repo_id: f.repo, job, supervisor: 'synthetic', model_calls: 0, created_at: Date.now() };
  const container = containerBindings(f.scoped, scope);
  const call = (scoped: Env = container.scoped) => modelHandler('claude')(new Request('http://model.internal/v1/messages', {
    method: 'POST', body: JSON.stringify({ max_tokens: 99999, thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: 'Synthetic difficult task' }],
      workspace_spend: { version: 1 }, campaign_opus: true, repair_round: 2 }),
  }), scoped, { containerId: 'synthetic' } as Parameters<ReturnType<typeof modelHandler>>[2]);
  const detail = () => ledger(bindings, f.repo, { op: 'run_detail', run_id: 'explicit-opus' });
  return { ...f, job, scope, container, call, detail };
}
it('allows explicitly approved ordinary Opus under the shared cap and frozen pricing without legacy escalation flags', async () => {
  const f = await fixture();
  const legacy = await workspace(bindings, f.owner, { op: 'budget_status' });
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 4096, thinking: { type: 'adaptive' } });
    for (const field of ['workspace_spend', 'campaign_opus', 'repair_round']) expect(body[field]).toBeUndefined();
    return Response.json({ type: 'message', usage: { input_tokens: 100, output_tokens: 10 } });
  });
  vi.stubGlobal('fetch', fetch);
  const response = await f.call(); expect(response.status).toBe(200); await response.text();
  expect(fetch).toHaveBeenCalledOnce();
  expect(await workspaceSpendStatus(bindings, f.owner)).toMatchObject({ charged_microusd: 1000, reserved_microusd: 0 });
  expect(await workspace(bindings, f.owner, { op: 'budget_status' })).toEqual(legacy);
  expect((await f.detail()).run.model_budgets[0]).toMatchObject({ requests: 1, charged_microusd: 1000 });
});
it('rejects an old unmarked Opus job despite forged provider-input approval and repair flags', async () => {
  const f = await fixture(false);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect((await f.call()).status).toBe(409);
  expect(fetch).not.toHaveBeenCalled();
  expect((await f.detail()).run.model_budgets[0].requests).toBe(0);
});
it('rejects a container scope with another run/model budget before consuming a request', async () => {
  const f = await fixture();
  await approvedLedger(bindings, f.repo)({ op: 'start_run', id: 'other-run', _workspace_spend: true,
    intent: 'Different approved group', agents: [{ provider: 'codex', model: 'gpt-5.6-luna', connection: 'reviewer-codex', strategy: 'Other' }],
    model_budgets: [campaignModelBudgets[1]] });
  const job = structuredClone(f.job); job.payload.execution.run_id = 'other-run';
  const scoped = containerBindings(f.scoped, { ...f.scope, job }).scoped;
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const response = await f.call(scoped); expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'WORKSPACE_SPEND_SCOPE' } });
  expect(fetch).not.toHaveBeenCalled();
  expect((await f.detail()).run.model_budgets[0].requests).toBe(0);
});
it('rejects a reservation pricing readback mismatch and releases only known-unused money, retaining the request count', async () => {
  const f = await fixture();
  const original = f.container.scoped.REPOSITORIES;
  const scoped = { ...f.container.scoped, REPOSITORIES: {
    idFromName: (name: string) => original.idFromName(name),
    get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
      const result = await original.get(id).fetch(url, init);
      const value = await result.json<Json>();
      if (JSON.parse(String(init.body)).op === 'reserve_request' && result.ok)
        value.model_budget.pricing.output_microusd_per_million += 1;
      return Response.json(value, { status: result.status });
    } }),
  } } as unknown as Env;
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const response = await f.call(scoped); expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'WORKSPACE_SPEND_SCOPE' } });
  expect(fetch).not.toHaveBeenCalled();
  expect((await f.detail()).run.model_budgets[0]).toMatchObject({ requests: 1, charged_microusd: 0 });
  expect(await workspaceSpendStatus(bindings, f.owner)).toMatchObject({ charged_microusd: 0, reserved_microusd: 0 });
});
