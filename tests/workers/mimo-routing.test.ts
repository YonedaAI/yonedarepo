import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { prepareModelRequest } from '../../cloudflare/worker/model-policy';
import type { Env } from '../../cloudflare/worker/types';
import { providerCredentials } from '../../cloudflare/worker/vault';
import { ledger } from '../../cloudflare/worker/storage';
import { seal } from '../../cloudflare/worker/vault';
import { workspace } from '../../cloudflare/worker/workspace';

const bindings = env as unknown as Env;
afterEach(async () => { await reset(); });
const routing = { plan: 'token_plan', region: 'sgp' };
const job = (route?: object) => ({ kind: 'agent', model: 'mimo-v2.6-flash', payload: {
  execution: { provider: 'mimo', harness: 'claude', ...(route ? { routing: route } : {}) },
} });

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
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Legacy plan', workspace: owner,
    commit: 'a'.repeat(40), remote: { namespace: 'test', name: repo },
    policy: { version: 'v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1',
      required_checks: ['syntax'], build: { checks: [{ name: 'syntax', argv: ['node', '--check', 'app.js'], timeout_seconds: 30 }] } } });
  const start = () => bindings.SELF.fetch(`https://yoneda/api/repos/${repo}/start_run`, {
    method: 'POST', headers: { cookie }, body: JSON.stringify({ id: 'repaired', intent: 'Build a site',
      agents: ['minimal', 'accessible'].map(strategy => ({ strategy, provider: 'mimo', model: 'mimo-v2.6-flash' })) }),
  });
  const blocked = await start();
  expect(blocked.status).toBe(409);
  expect(await blocked.text()).toContain('Token Plan');
  expect((await ledger(bindings, repo, { op: 'snapshot' })).executions).toEqual([]);
  const update = () => bindings.SELF.fetch('https://yoneda/api/settings/connections/mimo', {
    method: 'POST', headers: { cookie }, body: JSON.stringify({ expected_version: saved.version ?? 0, routing }),
  });
  expect((await update()).status).toBe(200);
  const secret = await workspace(bindings, owner, { op: 'provider_secret', connection: 'mimo' });
  expect(secret.sealed).toEqual(sealed);
  expect(secret.routing).toEqual(routing);
  expect((await update()).status).toBe(409);
  expect((await start()).status).toBe(200);
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
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Route fixture',
    workspace: 'token_plan_user', commit: 'a'.repeat(40), remote: { namespace: 'test', name: repo },
    policy: { version: 'route-v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1',
      required_checks: ['syntax'], build: { checks: [{ name: 'syntax', argv: ['node', '--check', 'app.js'], timeout_seconds: 30 }] } } });
  const started = await bindings.SELF.fetch(`https://yoneda/api/repos/${repo}/start_run`, {
    method: 'POST', headers: { cookie }, body: JSON.stringify({ id: 'routed', intent: 'Build a site',
      agents: ['minimal', 'accessible'].map(strategy => ({ strategy, connection: connection.id,
        provider: 'mimo', model: 'mimo-v2.6-flash', routing: { plan: 'token_plan', region: 'cn' } })),
      delegation: { enabled: true, max_depth: 1, max_executions: 3 },
    }),
  });
  expect(started.status).toBe(200);
  const parent = await ledger(bindings, repo, { op: 'claim', job_id: 'job:routed:agent-1' });
  expect(parent.payload.execution.routing).toEqual(routing);
  const child = await ledger(bindings, repo, { op: 'delegate_agent', job_id: parent.id,
    epoch: parent.epoch, request_id: 'child', task: 'Build an independent approach', strategy: 'keyboard-first' });
  expect(child.execution.routing).toEqual(routing);
  expect((await save({ plan: 'api_credits' }, 'tp-offline-fixture-key')).status).toBe(400);
  expect((await save(routing, 'sk-offline-fixture-key')).status).toBe(400);
  expect((await save({ plan: 'token_plan', region: 'us' }, 'tp-offline-fixture-key')).status).toBe(400);
});
