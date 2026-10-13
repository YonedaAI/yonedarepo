import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, bindings, readyReviewer } from './reviewer-fixture';

afterEach(reset);
it('starts an explicit comparison roster with distinct identities and one shared allowance', async () => {
  const f = await readyReviewer('approval_compare_roster');
  const response = await api(f.scoped, `/api/repos/${f.repo}/start_run`, f.cookie, {
    id: 'comparison-role-run', mode: 'compare', intent: 'Compare two implementations',
    adaptive_team: { version: 1, requested_agents: [
      { connection: 'reviewer-codex', role: 'builder' },
      { connection: 'reviewer-codex', role: 'builder' },
    ] },
  });
  expect(response.status).toBe(200);
  const run = await response.json<Json>();
  expect(run.mode).toBe('compare');
  expect(run.agents).toHaveLength(2);
  expect(new Set(run.agents.map((agent: Json) => agent.strategy)).size).toBe(2);
  expect(run.workspace_spend).toEqual({ version: 1 });
  expect(run.adaptive_team).toBeUndefined();
  expect(run.model_budgets).toHaveLength(1);
});
const adaptive = (id: string) => ({ id, intent: 'Local route approval fixture; no model requests', adaptive_team: { version: 1, requested_agents: [{ connection: 'reviewer-codex', role: 'builder' }] } });
const allowance = (f: Awaited<ReturnType<typeof readyReviewer>>) => workspace(bindings, f.owner, { op: 'workspace_spend_status' });

it.each(['auto', 'user', 'admin'])('blocks %s first funding transition with active legacy work without cancellation or config', async (entry) => {
  const f = await readyReviewer(`approval_busy_${entry}`);
  await api(f.scoped, '/api/reviewer/trial', f.cookie, { request_id: 'legacy-active-route-123456' });
  const before = await ledger(bindings, f.repo, { op: 'snapshot' });
  const response = entry === 'auto'
    ? await api(f.scoped, `/api/repos/${f.repo}/start_run`, f.cookie, adaptive('new-owner-run'))
    : entry === 'user'
      ? await api(f.scoped, '/api/workspace/allowance', f.cookie, { expected_version: 0, limit_microusd: 40000000 })
      : await api(f.scoped, '/api/admin/workspace/allowance', '', { username: f.owner, expected_version: 0, limit_microusd: 50000000 }, true);
  expect(response.status).toBe(409);
  expect(await response.json<Json>()).toMatchObject({ error: { code: 'WORKSPACE_TRANSITION_BUSY' } });
  expect((await allowance(f)).version).toBe(0);
  expect((await ledger(bindings, f.repo, { op: 'snapshot' })).runs).toEqual(before.runs);
});

it('validates credentials of the whole adaptive pool before configuring funding even when its seed key is valid', async () => {
  const f = await readyReviewer('approval_pool_keys');
  const stub = bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${f.owner}`));
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE workspace_records SET payload=json_set(payload,'$.sealed',json('{}')) WHERE id='provider:reviewer-claude-sonnet-5-5'");
  });
  const response = await api(f.scoped, `/api/repos/${f.repo}/start_run`, f.cookie, adaptive('invalid-nonseed-key'));
  expect(response.status).toBe(409);
  expect(await response.json<Json>()).toMatchObject({ error: { code: 'PROVIDER_MISSING' } });
  expect((await allowance(f)).version).toBe(0);
  expect((await ledger(bindings, f.repo, { op: 'snapshot' })).runs).toEqual([]);
});

it('checks normalized fixed budgets against older ledger capabilities before configuring or creating a run', async () => {
  const f = await readyReviewer('approval_old_wasm');
  const real = f.scoped.REPOSITORIES;
  const scoped = { ...f.scoped, REPOSITORIES: { idFromName: (name: string) => real.idFromName(name), get: (id: DurableObjectId) => ({ fetch: async (url: string, options: RequestInit) => {
    const reply = await real.get(id).fetch(url, options);
    const command = JSON.parse(String(options.body));
    if (command.op !== 'repository_status' || !reply.ok) return reply;
    const status = await reply.json<Json>();
    delete status.capabilities.model_budgets;
    return Response.json(status);
  } }) } } as unknown as Env;
  const reply = await api(scoped, `/api/repos/${f.repo}/start_run`, f.cookie, { id: 'fixed-no-budget-body', intent: 'Do not bypass old Wasm', agents: [{ provider: 'codex', model: 'gpt-5.6-luna', connection: 'reviewer-codex', strategy: 'Fixed older client' }] });
  expect(reply.status).toBe(409);
  expect(await reply.json<Json>()).toMatchObject({ error: { code: 'LEDGER_UPDATING' } });
  expect((await allowance(f)).version).toBe(0);
  expect((await ledger(bindings, f.repo, { op: 'snapshot' })).runs).toEqual([]);
});

it('keeps ordinary fixed starts metered without adaptive markers or client authority and only operators can raise the cap', async () => {
  const f = await readyReviewer('approval_fixed_meter');
  const reply = await api(f.scoped, `/api/repos/${f.repo}/start_run`, f.cookie, { id: 'fixed-owner-run', intent: 'Preserve my fixed approval', workspace_spend: null, _workspace_spend: false, campaign: { id: 'forged' }, agents: [{ provider: 'codex', model: 'gpt-5.6-luna', connection: 'reviewer-codex', strategy: 'Owner role' }], model_budgets: [{ provider: 'codex', model: 'gpt-5.6-luna', max_requests: 2, max_output_tokens: 512, max_execution_ms: 60000, spend_limit_microusd: 100000 }] });
  expect(reply.status).toBe(200);
  const run = await reply.json<Json>();
  expect(run.workspace_spend).toEqual({ version: 1 });
  expect(run.campaign).toBeUndefined();
  expect(run.adaptive_team).toBeUndefined();
  expect(run.model_budgets[0]).toMatchObject({ max_requests: 2, max_output_tokens: 512, max_execution_ms: 60000, spend_limit_microusd: 100000 });
  expect((await api(f.scoped, '/api/workspace/allowance', f.cookie, { expected_version: 1, limit_microusd: 50000001 })).status).toBe(403);
  expect((await api(f.scoped, '/api/admin/workspace/allowance', '', { username: f.owner, expected_version: 1, limit_microusd: 60000000 }, true)).status).toBe(200);
});
