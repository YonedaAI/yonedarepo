import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { campaignGrant } from '../../cloudflare/worker/campaign-grant';
import { campaignForAttempt, verifyCampaignReservation } from '../../cloudflare/worker/campaign-usage';
import { prepareModelRequest } from '../../cloudflare/worker/model-policy';
import { modelHandler } from '../../cloudflare/worker/models';
import { campaignModelBudgets } from '../../cloudflare/worker/reviewer-campaign';
import { fetchRequest } from '../../cloudflare/worker/routes';
import { ledger } from '../../cloudflare/worker/storage';
import type { Json, Scope } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, bindings, containerBindings, readyReviewer } from './reviewer-fixture';

afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
const budget = { ...campaignModelBudgets[1], max_requests: 3, max_output_tokens: 256,
  max_execution_ms: 120000, spend_limit_microusd: 4000 };
async function setup(extraBudgets: Json[] = []) {
  const f = await readyReviewer();
  const approval = { version: 1, audience: 'owner', repo_ids: [f.repo], expires: Date.UTC(2026, 9, 23),
    limit_microusd: 50000000, chain_limit_microusd: 4000,
    buckets: { routine: 35000000, opus: 10000000, reserve: 5000000 }, model_budgets: [budget, ...extraBudgets] };
  await workspace(bindings, f.owner, { op: 'campaign_configure', id: 'fresh', expected_version: 0, approval });
  await workspace(bindings, f.owner, { op: 'campaign_enable', id: 'fresh', expected_version: 1,
    expected_revision: 1, local_gate_receipt: 'synthetic successful gate' });
  const campaign = { id: 'fresh', version: 1, chain_id: 'maintenance', bucket: 'routine', purpose: 'routine' };
  const binding = await workspace(bindings, f.owner, { op: 'campaign_bind_run', ...campaign,
    repo_id: f.repo, run_id: 'initial', model_budgets: [budget, ...extraBudgets] });
  const request = { id: 'initial', intent: 'Synthetic metered campaign',
    campaign, agents: [{ provider: 'codex', model: 'gpt-5.6-luna', connection: 'reviewer-codex', strategy: 'Synthetic' },
      ...extraBudgets.map(b => ({ provider: b.provider, model: b.model, strategy: 'Synthetic original participant' }))],
    model_budgets: [budget, ...extraBudgets] };
  const grant = await campaignGrant(bindings, f.owner, f.repo, request, binding);
  await ledger(bindings, f.repo, { ...request, op: 'start_run', _workspace: f.owner, _campaign_grant: grant });
  const job = await ledger(bindings, f.repo, { op: 'claim', job_id: 'job:initial:agent-1' });
  const scope: Scope = { repo_id: f.repo, job, supervisor: 'synthetic', model_calls: 0, created_at: Date.now() };
  const container = containerBindings(f.scoped, scope);
  const call = () => modelHandler('codex')(new Request('http://model.internal/v1/responses', {
    method: 'POST', body: JSON.stringify({ input: 'Synthetic hello', max_output_tokens: 256,
      campaign: { id: 'forged', bucket: 'reserve' }, model: 'gpt-6-astra' }),
  }), container.scoped, { containerId: 'synthetic' } as Parameters<ReturnType<typeof modelHandler>>[2]);
  return { ...f, approval, campaign, binding, request, grant, job, container, call };
}
it('binds upstream usage from the authoritative run and retains historical spend', async () => {
  const f = await setup();
  await workspace(bindings, f.owner, { op: 'budget_reserve', id: 'old-spend', amount: 1234 });
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect(JSON.parse(String(init.body)).model).toBe('gpt-5.6-luna');
    return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 10 } });
  });
  vi.stubGlobal('fetch', fetch);
  const response = await f.call();
  expect(response.status).toBe(200); await response.text();
  expect((await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' })).charged_microusd).toBe(37);
  expect((await workspace(bindings, f.owner, { op: 'budget_status' })).charged).toBe(1234);
  expect(fetch).toHaveBeenCalledOnce();
  await evictDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${f.owner}`)));
  expect((await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' })).charged_microusd).toBe(37);
});
it('reads the frozen campaign from the real Wasm reservation, not supplied model arguments', async () => {
  const f = await setup();
  expect(f.job.payload.run.campaign).toEqual(f.campaign);
  const counted = await ledger(bindings, f.repo, { op: 'reserve_request', job_id: f.job.id,
    epoch: f.job.epoch, kind: 'model', input_bytes: 100, output_tokens: 256,
    campaign: { ...f.campaign, bucket: 'reserve', chain_id: 'forged' } });
  expect(counted.campaign).toEqual(f.campaign);
  expect(() => verifyCampaignReservation(f.binding, counted)).not.toThrow();
  for (const campaign of [undefined, null, { ...f.campaign, chain_id: 'forged' },
    { ...f.campaign, bucket: 'reserve' }, { ...f.campaign, version: 2 },
    { ...f.campaign, purpose: 'other' }, { ...f.campaign, id: 'other' },
    { ...f.campaign, extra: true }])
    expect(() => verifyCampaignReservation(f.binding, { ...counted, campaign }))
      .toThrow('Campaign reservation differs');
  expect(() => verifyCampaignReservation(null, counted)).toThrow('Campaign reservation differs');
  expect(() => verifyCampaignReservation(null, { number: 1 })).not.toThrow();
});

async function finishedCoordinator(sharedPreferredExhausted = false) {
  const extraBudgets = sharedPreferredExhausted ? [{ ...budget, provider: 'zai', model: 'glm-5.3-flash' }] : [];
  const f = await setup(extraBudgets);
  const id = 'coordinated';
  const binding = await workspace(bindings, f.owner, { op: 'campaign_bind_run', ...f.campaign,
    repo_id: f.repo, run_id: id, model_budgets: [budget, ...extraBudgets] });
  const request = { ...f.request, id, mode: 'collaborate',
    autonomy_policy: { version: 1, enabled: true, max_repair_rounds: 2, max_concurrent_agents: 3,
      max_executions: 20, source_scope: 'project', allow_intent_questions: true },
    team: { version: 1, contract: 'Keep the original API intent', integrator_agent: sharedPreferredExhausted ? 1 : 0,
      integration_paths: ['public/'], tasks: [{ id: 'api', title: 'API', instructions: 'Implement the API',
        agent: 0, depends_on: [], write_paths: ['src/'] }] } };
  const grant = await campaignGrant(bindings, f.owner, f.repo, request, binding);
  await ledger(bindings, f.repo, { ...request, op: 'start_run', _workspace: f.owner, _campaign_grant: grant });
  const source = await ledger(bindings, f.repo, { op: 'claim', job_id: `job:${id}:task:api` });
  await ledger(bindings, f.repo, { op: 'fail', job_id: source.id, epoch: source.epoch,
    retryable: false, error: 'Synthetic source failure' });
  const detail = await ledger(bindings, f.repo, { op: 'run_detail', run_id: id });
  const coordinator = await ledger(bindings, f.repo, { op: 'claim', job_id: `job:${detail.run.coordinator_execution_id}` });
  const reservation = await ledger(bindings, f.repo, { op: 'reserve_request', job_id: coordinator.id,
    epoch: coordinator.epoch, kind: 'model', input_bytes: 100, output_tokens: 256 });
  await workspace(bindings, f.owner, { op: 'campaign_reserve', repo_id: f.repo, run_id: id,
    reservation_id: 'retained-coordination', provider: coordinator.payload.execution.provider, model: coordinator.model,
    input_bytes: 100, output_tokens: 256, amount: reservation.reservation_microusd, count_only: false });
  await workspace(bindings, f.owner, { op: 'campaign_settle', repo_id: f.repo, run_id: id,
    reservation_id: 'retained-coordination', provider: coordinator.payload.execution.provider, model: coordinator.model,
    input_tokens: 100, output_tokens: 10 });
  await ledger(bindings, f.repo, { op: 'settle_model_request', job_id: coordinator.id,
    epoch: coordinator.epoch, reservation_id: reservation.reservation_id, input_tokens: 100, output_tokens: 10 });
  await ledger(bindings, f.repo, { op: 'finish', job_id: coordinator.id, epoch: coordinator.epoch,
    result: { planning: true, source_unchanged: true } });
  if (sharedPreferredExhausted) {
    for (const reservation_id of ['prior-stage-two', 'prior-stage-three']) {
      await workspace(bindings, f.owner, { op: 'campaign_reserve', repo_id: f.repo, run_id: 'initial',
        reservation_id, provider: 'zai', model: 'glm-5.3-flash', input_bytes: 100,
        output_tokens: 256, amount: reservation.reservation_microusd, count_only: false });
      await workspace(bindings, f.owner, { op: 'campaign_settle', repo_id: f.repo, run_id: 'initial',
        reservation_id, provider: 'zai', model: 'glm-5.3-flash', input_tokens: 0, output_tokens: 0 });
    }
  }
  const command = { username: f.owner, repo_id: f.repo, run_id: id, request_id: 'after-runtime-fix',
    expected_coordinator_job: coordinator.id, expected_epoch: coordinator.epoch,
    expected_commit: 'a'.repeat(40), expected_version: 0, expected_plan_revision: 1 };
  return { ...f, command, id };
}
it('retries a completed inactive coordinator once across eviction without renewing campaign authority', async () => {
  const f = await finishedCoordinator();
  const before = await ledger(bindings, f.repo, { op: 'run_detail', run_id: f.id });
  expect(before.run.status).toBe('failed');
  const accounting = await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' });
  const denied = await api(f.scoped, '/api/admin/campaign/retry_coordinator', f.cookie, f.command);
  expect(denied.status).toBe(403);
  const stale = await api(f.scoped, '/api/admin/campaign/retry_coordinator', '',
    { ...f.command, expected_plan_revision: 2 }, true);
  expect(stale.status).toBe(409);
  const result = await api(f.scoped, '/api/admin/campaign/retry_coordinator', '', f.command, true);
  expect(result.status).toBe(200);
  const receipt = await result.json<Json>();
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(f.repo)));
  const replay = await api(f.scoped, '/api/admin/campaign/retry_coordinator', '', f.command, true);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  const second = await api(f.scoped, '/api/admin/campaign/retry_coordinator', '',
    { ...f.command, request_id: 'another' }, true);
  expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({ error: { code: 'COORDINATION_RETRY_EXHAUSTED' } });
  const after = await ledger(bindings, f.repo, { op: 'run_detail', run_id: f.id });
  expect(after.run.status).toBe('coordinating');
  expect(after.executions).toHaveLength(before.executions.length + 1);
  for (const key of ['campaign', 'autonomy_approval', 'model_budgets', 'team_plan', 'team_repair_rounds'])
    expect(after.run[key]).toEqual(before.run[key]);
  expect(await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' })).toEqual(accounting);
});
it('refuses coordinator recovery when the existing workspace chain is disabled without resetting its charges', async () => {
  const f = await finishedCoordinator();
  const state = await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' });
  await workspace(bindings, f.owner, { op: 'campaign_disable', id: 'fresh',
    expected_version: state.version, expected_revision: state.revision });
  const response = await api(f.scoped, '/api/admin/campaign/retry_coordinator', '', f.command, true);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'CAMPAIGN_DISABLED' } });
  expect((await ledger(bindings, f.repo, { op: 'run_detail', run_id: f.id })).run.status).toBe('failed');
  expect((await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' })).charged_microusd)
    .toBe(state.charged_microusd);
});
it('selects another original group when prior stages exhausted the preferred shared group', async () => {
  const f = await finishedCoordinator(true);
  const accounting = await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' });
  expect(accounting.chains[0].models['zai/glm-5.3-flash'].requests).toBe(3);
  const before = await ledger(bindings, f.repo, { op: 'run_detail', run_id: f.id });
  expect(before.run.unavailable_model_groups ?? []).toEqual([]);
  expect(before.run.model_budgets.find((b: Json) => b.provider === 'zai').requests).toBe(1);
  const response = await api(f.scoped, '/api/admin/campaign/retry_coordinator', '',
    { ...f.command, _shared_model_limits: [], model_budgets: [] }, true);
  expect(response.status).toBe(200);
  const receipt = await response.json<Json>();
  const after = await ledger(bindings, f.repo, { op: 'run_detail', run_id: f.id });
  expect(after.executions.find((e: Json) => e.id === receipt.execution_id).model).toBe('gpt-5.6-luna');
  expect(after.run.unavailable_model_groups[0].model).toBe('glm-5.3-flash');
  expect(after.run.model_budgets).toEqual(before.run.model_budgets);
  expect(after.run.autonomy_approval).toEqual(before.run.autonomy_approval);
  expect(await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' })).toEqual(accounting);
});
it('atomically caps shared stages, replays reservations and keeps unknown usage charged', async () => {
  const f = await setup();
  const reserve = (id: string) => workspace(bindings, f.owner, { op: 'campaign_reserve', repo_id: f.repo,
    run_id: 'initial', reservation_id: id, provider: budget.provider, model: budget.model,
    input_bytes: 100, output_tokens: 256, amount: 2381, count_only: false });
  const results = await Promise.allSettled([reserve('first'), reserve('second')]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  const id = results[0].status === 'fulfilled' ? 'first' : 'second';
  await reserve(id);
  await evictDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${f.owner}`)));
  expect((await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' })).charged_microusd).toBe(2381);
  const upstream = vi.fn(async () => { throw new Error('Synthetic transport failure'); });
  vi.stubGlobal('fetch', upstream);
  expect((await f.call()).status).toBe(409); // Insufficient chain headroom; no upstream I/O.
  expect(upstream).not.toHaveBeenCalled();
});
it('refuses forged or absent campaign run bindings before upstream I/O', async () => {
  const f = await setup();
  const binding = await campaignForAttempt(bindings, f.owner, f.repo, f.job);
  expect(binding?.id).toBe('fresh');
  const foreign = { ...f.job, payload: { ...f.job.payload, execution: { ...f.job.payload.execution, run_id: 'unknown' } } };
  await expect(campaignForAttempt(bindings, f.owner, f.repo, foreign)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const response = await api(f.scoped, '/api/admin/campaign/enable', f.cookie,
    { username: f.owner, id: 'fresh', expected_version: 1, expected_revision: 2, local_gate_receipt: 'forged' });
  expect(response.status).toBe(403);
});
it('allows Opus adaptive tool streams only for the original one-shot second repair', () => {
  const opus = campaignModelBudgets[3];
  const job: Json = { kind: 'agent', model: opus.model, payload: { execution: { harness: 'claude', provider: 'claude', campaign_opus: true, repair_round: 2 },
    run: { repair_escalation: { model: opus.model }, model_budgets: [opus] } } };
  const body = prepareModelRequest(job, 'claude', '/v1/messages', { stream: true, max_tokens: 99999,
    thinking: { type: 'enabled', budget_tokens: 16000, display: 'updates' },
    tools: [{ name: 'local_read', input_schema: { type: 'object' } }], tool_choice: { type: 'auto' } }).body;
  expect(body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 4096, stream: true,
    thinking: { type: 'adaptive', display: 'summarized' } });
  expect(() => prepareModelRequest(job, 'claude', '/v1/messages', { thinking: { type: 'disabled' } })).toThrow('adaptive');
  expect(() => prepareModelRequest(job, 'claude', '/v1/messages', { tool_choice: { type: 'any' } })).toThrow('Forced');
  delete job.payload.execution.campaign_opus;
  expect(() => prepareModelRequest(job, 'claude', '/v1/messages', {})).toThrow('preapproved');
});

it('rejects unsigned, forged, cross-account and altered-command campaign grants atomically', async () => {
  const f = await setup();
  for (const alteration of [
    { id: 'unsigned', _campaign_grant: undefined },
    { id: 'forged', _campaign_grant: { ...f.grant, signature: '0'.repeat(64) }, _campaign_signing_key: '0'.repeat(64) },
    { id: 'cross-account', _workspace: 'someone_else' },
    { id: 'changed-command', intent: 'Unapproved goal' },
  ]) {
    await expect(ledger(bindings, f.repo, { ...f.request, op: 'start_run', _workspace: f.owner,
      _campaign_grant: f.grant, ...alteration })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }
  const snapshot = await ledger(bindings, f.repo, { op: 'snapshot', _workspace: f.owner });
  expect(snapshot.runs.map((run: Json) => run.id)).toEqual(['initial']);
  expect(snapshot.runs[0]).not.toHaveProperty('_campaign_signing_key');
  expect(snapshot.runs[0]).not.toHaveProperty('_campaign_grant');
});

it('retains the complete campaign reservation after upstream acknowledgement loss', async () => {
  const f = await setup();
  const upstream = vi.fn(async () => { throw new Error('Synthetic upstream acknowledgement loss'); });
  vi.stubGlobal('fetch', upstream);
  expect((await f.call()).ok).toBe(false);
  expect(upstream).toHaveBeenCalledOnce();
  const status = await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' });
  expect(status.charged_microusd).toBeGreaterThan(0);
  await evictDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${f.owner}`)));
  expect((await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' })).charged_microusd).toBe(status.charged_microusd);
});

it('stops a fresh attempt when its original shared model allowance is already exhausted', async () => {
  const f = await setup();
  const upstream = vi.fn(async () => Response.json({ status: 'completed',
    usage: { input_tokens: 100, output_tokens: 10 } }));
  vi.stubGlobal('fetch', upstream);
  for (let i = 0; i < 3; i++) {
    const result = await f.call();
    expect(result.status).toBe(200);
    await result.text();
  }
  const before = await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' });
  const binding = await workspace(bindings, f.owner, { op: 'campaign_bind_run', ...f.campaign,
    repo_id: f.repo, run_id: 'next-stage', model_budgets: [budget] });
  const request = { ...f.request, id: 'next-stage' };
  const grant = await campaignGrant(bindings, f.owner, f.repo, request, binding);
  await ledger(bindings, f.repo, { ...request, op: 'start_run', _workspace: f.owner, _campaign_grant: grant });
  const job = await ledger(bindings, f.repo, { op: 'claim', job_id: 'job:next-stage:agent-1' });
  const scope: Scope = { repo_id: f.repo, job, supervisor: 'synthetic', model_calls: 0, created_at: Date.now() };
  const container = containerBindings(f.scoped, scope);
  const result = await modelHandler('codex')(new Request('http://model.internal/v1/responses', {
    method: 'POST', body: JSON.stringify({ input: 'Synthetic next stage', max_output_tokens: 256 }),
  }), container.scoped, { containerId: 'synthetic' } as Parameters<ReturnType<typeof modelHandler>>[2]);
  expect(result.status).toBe(409);
  expect(await result.json()).toMatchObject({ error: { code: 'CAMPAIGN_MODEL_REQUEST_LIMIT' } });
  expect(upstream).toHaveBeenCalledTimes(3);
  const after = await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' });
  expect(after.chains).toEqual(before.chains);
  expect(after.charged_microusd).toBe(before.charged_microusd);
  const detail = await ledger(bindings, f.repo, { op: 'run_detail', run_id: 'next-stage' });
  expect(detail.run.status).toBe('failed');
  expect(detail.executions[0].status).toBe('failed');
  expect(detail.run.model_budgets[0].max_requests).toBe(3);
  expect(detail.run.campaign).toEqual(f.campaign);
  const forbiddenObservation = await fetchRequest(new Request(
    `https://yoneda/api/repos/${f.repo}/observe_campaign_model_limit`, {
      method: 'POST', headers: { cookie: f.cookie, origin: 'https://yoneda', 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: job.id, epoch: job.epoch, requests: 3, max_requests: 3 }),
    }), f.scoped);
  // Counter observation remains an internal adapter operation, not an owner route.
  expect(forbiddenObservation.status).toBe(404);
  expect(await forbiddenObservation.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
});

it('never accepts operator-supplied quota counts or ordinary-account reconciliation', async () => {
  const f = await setup();
  const input = { username: f.owner, repo_id: f.repo, job_id: f.job.id,
    requests: 999, max_requests: 1, provider: 'codex', model: 'gpt-5.6-luna' };
  const denied = await api(f.scoped, '/api/admin/campaign/reconcile_model_limit', f.cookie, input);
  expect(denied.status).toBe(403);
  const notExhausted = await api(f.scoped, '/api/admin/campaign/reconcile_model_limit', '', input, true);
  expect(notExhausted.status).toBe(409);
  expect(await notExhausted.json()).toMatchObject({ error: { code: 'CAMPAIGN_EXHAUSTED' } });
  const detail = await ledger(bindings, f.repo, { op: 'run_detail', run_id: 'initial' });
  expect(detail.executions[0].status).toBe('running');
  expect(detail.run.unavailable_model_groups ?? []).toEqual([]);
  expect((await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' })).charged_microusd).toBe(0);
});

it('changes only next-version repository scope through the real Wasm workspace without resetting spent chains', async () => {
  const f = await setup();
  await workspace(bindings, f.owner, { op: 'campaign_reserve', repo_id: f.repo,
    run_id: 'initial', reservation_id: 'retained', provider: budget.provider, model: budget.model,
    input_bytes: 100, output_tokens: 256, amount: 2381, count_only: false });
  const before = await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' });
  await workspace(bindings, f.owner, { op: 'campaign_disable', id: 'fresh', expected_version: 1,
    expected_revision: before.revision });
  const next = { ...f.approval, version: 2, repo_ids: ['new-maintenance-project'],
    buckets: { opus: 10000000, reserve: 5000000, routine: 35000000 } };
  await workspace(bindings, f.owner, { op: 'campaign_configure', id: 'fresh', expected_version: 1, approval: next });
  const after = await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' });
  expect(after.version).toBe(2);
  expect(after.approval).toEqual(next);
  expect(after.charged_microusd).toBe(2381);
  expect(after.chains).toEqual(before.chains);
  await workspace(bindings, f.owner, { op: 'campaign_configure', id: 'fresh', expected_version: 1, approval: f.approval });
  await evictDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${f.owner}`)));
  expect((await workspace(bindings, f.owner, { op: 'campaign_status', id: 'fresh' })).chains).toEqual(before.chains);
});
