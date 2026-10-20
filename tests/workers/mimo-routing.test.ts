import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { prepareModelRequest } from '../../cloudflare/worker/model-policy';
import type { Env, Json } from '../../cloudflare/worker/types';
import { providerCredentials } from '../../cloudflare/worker/vault';
import { ledger } from '../../cloudflare/worker/storage';
import { seal } from '../../cloudflare/worker/vault';
import { workspace } from '../../cloudflare/worker/workspace';
import { fetchRequest } from '../../cloudflare/worker/routes';
import { platformProject } from './platform-fixture';
import { approvedLedger } from './source-kit';

const bindings = env as unknown as Env;
// Run approval reads the canonical commit back from the project's platform repository.
const startRun = (url: string, init: RequestInit) => fetchRequest(new Request(url, init), bindings);
afterEach(async () => { await reset(); });
const routing = { plan: 'token_plan', region: 'sgp' };
const job = (route?: object) => ({ kind: 'agent', model: 'mimo-v2.6-flash', payload: {
  execution: { provider: 'mimo', harness: 'claude', ...(route ? { routing: route } : {}) },
} });

// Explicit grandfathered approval fixture: no generic new-run pricing, funding or upstream calls.
async function approvedLegacyFixture(owner: string, repo: string, input: Json) {
  const agents = [];
  for (const agent of input.agents) {
    const saved = await workspace(bindings, owner, { op: 'provider_secret', connection: agent.connection ?? agent.provider });
    const credentials = await providerCredentials(bindings, owner, agent.provider,
      agent.connection ?? agent.provider, agent.model, saved.routing);
    agents.push({ ...agent, routing: credentials.routing });
  }
  return approvedLedger(bindings, repo)({ ...input, agents, op: 'start_run', _workspace: owner });
}

it('pins Token Plan requests to the approved region and rejects arbitrary destinations', () => {
  for (const region of ['cn', 'sgp', 'ams']) {
    const result = prepareModelRequest(job({ plan: 'token_plan', region }), 'claude', '/v1/messages', {});
    expect(result.url).toBe(`https://token-plan-${region}.xiaomimimo.com/anthropic/v1/messages`);
  }
  expect(prepareModelRequest(job(), 'claude', '/v1/messages', {}).url)
    .toBe('https://api.xiaomimimo.com/anthropic/v1/messages');
  for (const route of [{ plan: 'token_plan' }, { plan: 'token_plan', region: 'us' },
    { plan: 'token_plan', region: 'sgp', url: 'https://attacker.invalid' }]) {
    expect(() => prepareModelRequest(job(route), 'claude', '/v1/messages', {})).toThrow();
  }
});

it('blocks a legacy Token Plan key on the API route before scheduling and repairs it without replacing the secret', async () => {
  const owner = 'legacy_plan_user';
  const signup = await bindings.SELF.fetch('https://yoneda/api/auth/signup', { method: 'POST',
    body: JSON.stringify({ username: owner, password: 'a long test password' }) });
  const cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0];
  const sealed = await seal(bindings, owner, 'mimo', 'tp-legacy-offline-fixture');
  const saved = await workspace(bindings, owner, { op: 'provider_put', provider: 'mimo',
    model: 'mimo-v2.6-flash', sealed });
  const repo = 'legacy-plan-fixture';
  await platformProject(bindings, owner, repo, { 'app.js': 'void 0;\n' }, { version: 'v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1',
      required_checks: ['syntax'], build: { checks: [{ name: 'syntax', argv: ['node', '--check', 'app.js'], timeout_seconds: 30 }] } });
  const start = () => startRun(`https://yoneda/api/repos/${repo}/start_run`, {
    method: 'POST', headers: { cookie }, body: JSON.stringify({ id: 'repaired', intent: 'Build a site',
      agents: ['minimal', 'accessible'].map(strategy => ({ strategy, provider: 'mimo', model: 'mimo-v2.6-flash' })) }),
  });
  const blocked = await start();
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({ error: { code: 'PROVIDER_MISSING' } });
  expect((await workspace(bindings, owner, { op: 'workspace_spend_status' })).version).toBe(0);
  await expect(providerCredentials(bindings, owner, 'mimo', 'mimo', 'mimo-v2.6-flash'))
    .rejects.toThrow('Token Plan');
  expect((await ledger(bindings, repo, { op: 'snapshot' })).executions).toEqual([]);
  const update = () => bindings.SELF.fetch('https://yoneda/api/settings/connections/mimo', {
    method: 'POST', headers: { cookie }, body: JSON.stringify({ expected_version: saved.version ?? 0, routing }),
  });
  expect((await update()).status).toBe(200);
  const secret = await workspace(bindings, owner, { op: 'provider_secret', connection: 'mimo' });
  expect(secret.sealed).toEqual(sealed);
  expect(secret.routing).toEqual(routing);
  expect((await update()).status).toBe(409);
  const pricedStart = await start();
  expect(pricedStart.status).toBe(200);
  const ordinary = await pricedStart.json<Json>();
  expect(ordinary.workspace_spend).toEqual({ version: 1 });
  expect(ordinary.agents.every((agent: Json) => agent.routing.region === 'sgp')).toBe(true);
  expect(ordinary.model_budgets).toEqual([expect.objectContaining({ provider: 'mimo', model: 'mimo-v2.6-flash',
    max_requests: 144, max_output_tokens: 4096, spend_limit_microusd: 50000000,
    pricing: expect.objectContaining({ input_microusd_per_million: 140000, output_microusd_per_million: 280000 }) })]);
  expect(await workspace(bindings, owner, { op: 'workspace_spend_status' })).toMatchObject({
    version: 1, limit_microusd: 50000000, charged_microusd: 0, reserved_microusd: 0, remaining_microusd: 50000000,
  });
  const fixed = await approvedLegacyFixture(owner, repo, { id: 'legacy-repaired', intent: 'Prior approved routing fixture',
    agents: ['minimal', 'accessible'].map(strategy => ({ strategy, provider: 'mimo', model: 'mimo-v2.6-flash' })) });
  expect(fixed.workspace_spend).toBeUndefined();
  expect((await ledger(bindings, repo, { op: 'snapshot' })).executions.every((e: any) => e.routing.region === 'sgp')).toBe(true);
});

it('stores only encrypted plan keys, exposes the route and fences changed routing', async () => {
  const signup = await bindings.SELF.fetch('https://yoneda/api/auth/signup', { method: 'POST',
    body: JSON.stringify({ username: 'token_plan_user', password: 'a long test password' }) });
  const cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0];
  const save = (route: object, key: string) => bindings.SELF.fetch('https://yoneda/api/settings/connections', {
    method: 'POST', headers: { cookie }, body: JSON.stringify({ label: 'Coding subscription',
      provider: 'mimo', model: 'mimo-v2.6-flash', routing: route, key }),
  });
  const saved = await save(routing, 'tp-offline-fixture-key');
  expect(saved.status).toBe(200);
  const connection = await saved.json() as { id: string };
  const credentials = await providerCredentials(bindings, 'token_plan_user', 'mimo',
    connection.id, 'mimo-v2.6-flash', routing);
  expect(credentials.key).toBe('tp-offline-fixture-key');
  expect(credentials.routing).toEqual(routing);
  await expect(providerCredentials(bindings, 'token_plan_user', 'mimo', connection.id,
    'mimo-v2.6-flash', { plan: 'api_credits' })).rejects.toThrow('routing changed');
  const settings = await bindings.SELF.fetch('https://yoneda/api/settings', { headers: { cookie } });
  const text = await settings.text();
  expect(text).toContain('token_plan');
  expect(text).toContain('sgp');
  expect(text).not.toContain('tp-offline-fixture-key');
  expect(text).not.toContain('ciphertext');
  const repo = 'token-plan-routing-fixture';
  await platformProject(bindings, 'token_plan_user', repo, { 'app.js': 'void 0;\n' }, { version: 'route-v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1',
      required_checks: ['syntax'], build: { checks: [{ name: 'syntax', argv: ['node', '--check', 'app.js'], timeout_seconds: 30 }] } });
  const started = await startRun(`https://yoneda/api/repos/${repo}/start_run`, {
    method: 'POST', headers: { cookie }, body: JSON.stringify({ id: 'routed', intent: 'Build a site',
      agents: ['minimal', 'accessible'].map(strategy => ({ strategy, connection: connection.id,
        provider: 'mimo', model: 'mimo-v2.6-flash', routing: { plan: 'token_plan', region: 'cn' } })),
      delegation: { enabled: true, max_depth: 1, max_executions: 3 },
    }),
  });
  expect(started.status).toBe(200);
  const ordinary = await started.json<Json>();
  expect(ordinary.workspace_spend).toEqual({ version: 1 });
  expect(ordinary.agents.every((agent: Json) => agent.routing.region === 'sgp')).toBe(true);
  expect(ordinary.model_budgets).toEqual([expect.objectContaining({ provider: 'mimo', model: 'mimo-v2.6-flash',
    max_requests: 144, max_output_tokens: 4096, spend_limit_microusd: 50000000 })]);
  expect(await workspace(bindings, 'token_plan_user', { op: 'workspace_spend_status' })).toMatchObject({
    version: 1, limit_microusd: 50000000, charged_microusd: 0, reserved_microusd: 0, remaining_microusd: 50000000,
  });
  const legacy = await approvedLegacyFixture('token_plan_user', repo, { id: 'legacy-routed', intent: 'Prior approved delegation routing fixture',
    agents: ['minimal', 'accessible'].map(strategy => ({ strategy, connection: connection.id,
      provider: 'mimo', model: 'mimo-v2.6-flash', routing: { plan: 'token_plan', region: 'cn' } })),
    delegation: { enabled: true, max_depth: 1, max_executions: 3 } });
  expect(legacy.workspace_spend).toBeUndefined();
  const parent = await ledger(bindings, repo, { op: 'claim', job_id: 'job:legacy-routed:agent-1' });
  expect(parent.payload.execution.routing).toEqual(routing);
  const child = await ledger(bindings, repo, { op: 'delegate_agent', job_id: parent.id,
    epoch: parent.epoch, request_id: 'child', task: 'Build an independent approach', strategy: 'keyboard-first' });
  expect(child.execution.routing).toEqual(routing);
  expect((await save({ plan: 'api_credits' }, 'tp-offline-fixture-key')).status).toBe(400);
  expect((await save(routing, 'sk-offline-fixture-key')).status).toBe(400);
  expect((await save({ plan: 'token_plan', region: 'us' }, 'tp-offline-fixture-key')).status).toBe(400);
});
