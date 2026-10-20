import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { Env, Json } from '../../cloudflare/worker/types';
import { open, providerCredentials, seal } from '../../cloudflare/worker/vault';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, bindings, signup } from './reviewer-fixture';

const path = '/api/admin/providers/managed';
const zaiKey = 'synthetic-store-zai-key';
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

/** Only Secrets Store is simulated; the vault and the Rust/Wasm workspace DO are real. */
function scoped(enabled: boolean, key = zaiKey) {
  const get = vi.fn(async () => key);
  const env = {
    ...bindings,
    ZAI_KEY: { get },
    MIMO_KEY: { get: async () => 'synthetic-store-mimo-key' },
    ...(enabled ? { MANAGED_PROVIDER_KEYS: 'secrets-store' } : {}),
  } as unknown as Env;
  return { env, get };
}
const providers = async (owner: string) =>
  (await workspace(bindings, owner, { op: 'settings' })).providers as Json[];

it('is not routed unless the deployment enables it', async () => {
  await signup('managed_off');
  const response = await api(scoped(false).env, path, '', { username: 'managed_off', provider: 'zai' }, true);
  expect(response.status).toBe(404);
  expect(await providers('managed_off')).toEqual([]);
});

it('refuses anyone but the owner credential', async () => {
  const cookie = await signup('managed_user');
  const response = await api(scoped(true).env, path, cookie, { username: 'managed_user', provider: 'zai' });
  expect(response.status).toBe(403);
  expect(await providers('managed_user')).toEqual([]);
});

it('refuses providers other than zai and mimo, unknown fields and unknown accounts', async () => {
  await signup('managed_bad');
  const { env } = scoped(true);
  for (const body of [
    { username: 'managed_bad', provider: 'codex' },
    { username: 'managed_bad', provider: 'claude' },
    { username: 'managed_bad', provider: 'zai', key: 'pasted' },
  ]) {
    const response = await api(env, path, '', body, true);
    expect(response.status).toBe(400);
    expect((await response.json<Json>()).error.code).toBe('INVALID_INPUT');
  }
  expect((await api(env, path, '', { username: 'nobody_here', provider: 'zai' }, true)).status).toBe(404);
  expect(await providers('managed_bad')).toEqual([]);
});

it('binds a reference resolved at call time; no response, log or vault entry holds the key', async () => {
  await signup('managed_ok');
  const { env, get } = scoped(true);
  const logs: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error'] as const)
    vi.spyOn(console, method).mockImplementation((...args) => void logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
  const response = await api(env, path, '', { username: 'managed_ok', provider: 'zai' }, true);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({ id: 'managed-zai', provider: 'zai', model: 'glm-5.3-flash', managed: true });
  expect(body).not.toMatch(/synthetic-store|sealed|ciphertext|yoneda-managed/);
  expect(logs.join('\n')).not.toContain(zaiKey);
  expect(logs.join('\n')).toContain('provider.managed_bound');
  // The vault holds an owner-bound reference, never the plaintext.
  const record = await workspace(bindings, 'managed_ok', { op: 'provider_secret', connection: 'managed-zai' });
  expect(await open(bindings, 'managed_ok', 'zai', record.sealed, 'managed-zai')).not.toContain(zaiKey);
  get.mockResolvedValue('rotated-store-zai-key');
  expect((await providerCredentials(env, 'managed_ok', 'zai', 'managed-zai')).key).toBe('rotated-store-zai-key');
});

it('fails closed when the flag is off at call time or the reference is forged', async () => {
  await signup('managed_closed');
  expect((await api(scoped(true).env, path, '', { username: 'managed_closed', provider: 'zai' }, true)).status).toBe(200);
  await expect(providerCredentials(scoped(false).env, 'managed_closed', 'zai', 'managed-zai')).rejects.toMatchObject({ code: 'PROVIDER_MISSING' });
  // A user who pastes a reference-shaped key gets nothing from the store.
  const record = await workspace(bindings, 'managed_closed', { op: 'provider_secret', connection: 'managed-zai' });
  const reference = await open(bindings, 'managed_closed', 'zai', record.sealed, 'managed-zai');
  await signup('managed_thief');
  await workspace(bindings, 'managed_thief', {
    op: 'provider_put',
    provider: 'zai',
    connection: 'zai',
    model: 'glm-5.3-flash',
    sealed: await seal(bindings, 'managed_thief', 'zai', reference, 'zai'),
  });
  await expect(providerCredentials(scoped(true).env, 'managed_thief', 'zai', 'zai')).rejects.toMatchObject({ code: 'PROVIDER_MISSING' });
});
