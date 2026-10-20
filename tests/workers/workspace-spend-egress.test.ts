import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { modelHandler } from '../../cloudflare/worker/models';
import { campaignModelBudgets } from '../../cloudflare/worker/reviewer-campaign';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { workspaceSpendConfigure, workspaceSpendStatus } from '../../cloudflare/worker/workspace-spend';
import { bindings, containerBindings, readyReviewer } from './reviewer-fixture';
import { approvedLedger } from './source-kit';

afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
const budget = { ...campaignModelBudgets[1], max_requests: 4, max_output_tokens: 256,
  max_execution_ms: 120000, spend_limit_microusd: 50000 };
async function setup(marked = true, limit = 50000, approved: Json = budget, adaptive = false) {
  const f = await readyReviewer();
  await workspaceSpendConfigure(bindings, f.owner, 0, limit);
  await approvedLedger(bindings, f.repo)({ op: 'start_run', id: 'ordinary-fixed', _workspace: f.owner,
    ...(marked ? { _workspace_spend: true } : {}), intent: 'Synthetic fixed ordinary request',
    ...(adaptive ? { mode: 'collaborate', adaptive_team: { version: 1, requested_agents: [{ connection: 'reviewer-codex', role: 'frontend' }] },
      _approved_model_pool: [{ connection: 'reviewer-codex', provider: 'codex', model: 'gpt-5.6-luna' }] } : {}),
    agents: [{ provider: 'codex', model: 'gpt-5.6-luna', connection: 'reviewer-codex', strategy: 'Synthetic', ...(adaptive ? { role_hint: 'frontend' } : {}) }],
    model_budgets: [approved] });
  const job = await ledger(bindings, f.repo, { op: 'claim', job_id: adaptive ? 'job:ordinary-fixed:planner' : 'job:ordinary-fixed:agent-1' });
  const scope: Scope = { repo_id: f.repo, job, supervisor: 'synthetic', model_calls: 0, created_at: Date.now() };
  const container = containerBindings(f.scoped, scope);
  const call = (scoped: Env = container.scoped) => modelHandler('codex')(new Request('http://model.internal/v1/responses', {
    method: 'POST', body: JSON.stringify({ input: 'Synthetic hello', max_output_tokens: 256,
      workspace_spend: { version: 1, limit_microusd: 999999999 }, model: 'forged-expensive-model' }),
  }), scoped, { containerId: 'synthetic' } as Parameters<ReturnType<typeof modelHandler>>[2]);
  const detail = () => ledger(bindings, f.repo, { op: 'run_detail', run_id: 'ordinary-fixed' });
  return { ...f, job, call, detail, container };
}

it('meters fixed ordinary account inference once from frozen pricing, ignoring provider body authority', async () => {
  const f = await setup();
  const legacy = await workspace(bindings, f.owner, { op: 'budget_status' });
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gpt-5.6-luna');
    expect(body.workspace_spend).toBeUndefined();
    return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 10 } });
  });
  vi.stubGlobal('fetch', fetch);
  const response = await f.call(); expect(response.status).toBe(200); await response.text();
  expect(f.job.payload.run.workspace_spend).toEqual({ version: 1 });
  expect(await workspaceSpendStatus(bindings, f.owner)).toEqual({ version: 1, limit_microusd: 50000,
    charged_microusd: 37, reserved_microusd: 0, remaining_microusd: 49963 });
  expect(await workspace(bindings, f.owner, { op: 'budget_status' })).toEqual(legacy);
  const detail = await f.detail();
  expect(detail.run.model_budgets[0]).toMatchObject({ requests: 1, charged_microusd: 37 });
  expect(fetch).toHaveBeenCalledOnce();
});

it('holds ambiguous upstream usage and rejects the next request before provider I/O while retaining its consumed count', async () => {
  const f = await setup(true, 4000);
  const fetch = vi.fn(async () => Response.json({ status: 'incomplete' }));
  vi.stubGlobal('fetch', fetch);
  const first = await f.call(); expect(first.status).toBe(200); await first.text();
  const before = await workspaceSpendStatus(bindings, f.owner);
  expect(before.reserved_microusd).toBeGreaterThan(2000);
  const second = await f.call(); expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({ error: { code: 'WORKSPACE_SPEND_EXHAUSTED' } });
  expect(fetch).toHaveBeenCalledOnce();
  await evictDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${f.owner}`)));
  expect(await workspaceSpendStatus(bindings, f.owner)).toEqual(before);
  const detail = await f.detail();
  expect(detail.run.model_budgets[0].requests).toBe(2);
  expect(detail.run.model_budgets[0].charged_microusd).toBe(before.reserved_microusd);
});

it('blocks legacy future inference after allowance transition without changing original approval or consuming a request', async () => {
  const f = await setup(false);
  const before = await f.detail();
  const fetch = vi.fn(async () => Response.json({ status: 'completed', usage: { input_tokens: 0, output_tokens: 0 } }));
  vi.stubGlobal('fetch', fetch);
  const response = await f.call(); expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'WORKSPACE_LEGACY_INFERENCE_BLOCKED' } });
  expect(fetch).not.toHaveBeenCalled();
  expect((await f.detail()).run.model_budgets).toEqual(before.run.model_budgets);
  expect(await workspaceSpendStatus(bindings, f.owner)).toMatchObject({ charged_microusd: 0, reserved_microusd: 0 });
});

it('retains the conservative amount when provider transport fails', async () => {
  const f = await setup();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic uncertain transport'); }));
  expect((await f.call()).status).toBe(409);
  const status = await workspaceSpendStatus(bindings, f.owner);
  expect(status.reserved_microusd).toBeGreaterThan(0);
  expect(status.charged_microusd).toBe(0);
  expect((await f.detail()).run.model_budgets[0].charged_microusd).toBe(status.reserved_microusd);
});

it('keeps a committed workspace reservation on lost acknowledgment without upstream or request-count refunds', async () => {
  const f = await setup();
  const original = f.container.scoped.WORKSPACES;
  const scoped = { ...f.container.scoped, WORKSPACES: {
    idFromName: (name: string) => original.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = original.get(id);
      return { fetch: async (url: string, init: RequestInit) => {
        const result = await stub.fetch(url, init);
        if (JSON.parse(String(init.body)).op === 'workspace_spend_reserve' && result.ok) {
          await result.text();
          throw new Error('Synthetic acknowledgment loss after durable commit');
        }
        return result;
      } };
    },
  } } as unknown as Env;
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect((await f.call(scoped)).status).toBe(409);
  expect(fetch).not.toHaveBeenCalled();
  await evictDurableObject(original.get(original.idFromName(`account:${f.owner}`)));
  expect((await workspaceSpendStatus(bindings, f.owner)).reserved_microusd).toBeGreaterThan(0);
  expect((await f.detail()).run.model_budgets[0]).toMatchObject({ requests: 1, charged_microusd: 0 });
});

it('prices an adaptive planner from the same shared allowance even without the fixed-run marker', async () => {
  const f = await setup(false, 50000, budget, true);
  const fetch = vi.fn(async () => Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 10 } }));
  vi.stubGlobal('fetch', fetch);
  expect(f.job.payload.run.workspace_spend).toBeUndefined();
  expect(f.job.payload.run.adaptive_team.version).toBe(1);
  const response = await f.call(); expect(response.status).toBe(200); await response.text();
  expect(await workspaceSpendStatus(bindings, f.owner)).toMatchObject({ charged_microusd: 37, reserved_microusd: 0 });
  expect(fetch).toHaveBeenCalledOnce();
});

it('rejects an unpriced marked run before any request count or upstream call', async () => {
  const f = await setup(true, 50000, { ...budget, pricing: null, spend_limit_microusd: null });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const response = await f.call(); expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'WORKSPACE_SPEND_SCOPE' } });
  expect(fetch).not.toHaveBeenCalled();
  expect((await f.detail()).run.model_budgets[0]).toMatchObject({ requests: 0, charged_microusd: 0 });
});
