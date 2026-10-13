import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import type { Json } from '../../cloudflare/worker/types';
import { open, providerCredentials } from '../../cloudflare/worker/vault';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, bindings, readyReviewer, signup } from './reviewer-fixture';

afterEach(reset);
const source = 'reviewer-claude-sonnet-5-5';
const target = 'claude-opus-5-5';

it('creates an immutable model-specific alias using only the server-held source key and new owner/connection AAD', async () => {
  const f = await readyReviewer('alias_owner');
  const original = await workspace(bindings, f.owner, { op: 'provider_secret', connection: source });
  const path = `/api/settings/connections/${source}/models`;
  const input = { model: target, expected_version: original.version };
  const created = await api(f.scoped, path, f.cookie, input);
  expect(created.status).toBe(200);
  const alias = await created.json<Json>();
  expect(alias).toMatchObject({ provider: 'claude', model: target, version: 1 });
  expect(JSON.stringify(alias)).not.toMatch(/sealed|ciphertext|synthetic-claude-key/);
  const retried = await api(f.scoped, path, f.cookie, input);
  expect(await retried.json<Json>()).toEqual(alias);
  const credentials = await providerCredentials(bindings, f.owner, 'claude', alias.id, target);
  expect(credentials.key).toBe('synthetic-claude-key');
  const stored = await workspace(bindings, f.owner, { op: 'provider_secret', connection: alias.id });
  await expect(open(bindings, f.owner, 'claude', stored.sealed, source)).rejects.toThrow();
  expect(await workspace(bindings, f.owner, { op: 'provider_secret', connection: source })).toEqual(original);
  await expect(providerCredentials(bindings, f.owner, 'claude', source, target)).rejects.toThrow('model changed');
  const settings = await (await api(f.scoped, '/api/settings', f.cookie)).text();
  expect(settings).not.toMatch(/synthetic-claude-key|ciphertext/);
  expect(JSON.parse(settings).providers.find((p: Json) => p.id === alias.id).alias_source).toEqual(alias.alias_source);
  const update = await api(f.scoped, `/api/settings/connections/${alias.id}`, f.cookie, { expected_version: 1, model: 'claude-sonnet-5-5' });
  expect(update.status).toBe(409);
  expect(await update.json<Json>()).toMatchObject({ error: { code: 'ALIAS_IMMUTABLE' } });
  const removed = await bindings.SELF.fetch(`https://yoneda/api/settings/connections/${alias.id}`, { method: 'DELETE', headers: { cookie: f.cookie, origin: 'https://yoneda' } });
  expect(removed.status).toBe(200);
  await expect(providerCredentials(bindings, f.owner, 'claude', alias.id, target)).rejects.toThrow();
  const retired = await api(f.scoped, path, f.cookie, input);
  expect(retired.ok).toBe(false);
  expect(await retired.json<Json>()).toMatchObject({ error: { code: 'ALIAS_RETIRED' } });
});

it('rejects other owners, stale source versions, unpriced models and browser-supplied secrets without allocating aliases', async () => {
  const f = await readyReviewer('alias_permissions');
  const original = await workspace(bindings, f.owner, { op: 'provider_secret', connection: source });
  const path = `/api/settings/connections/${source}/models`;
  const other = await signup('alias_other_owner');
  const attempts = [
    { cookie: other, body: { model: target, expected_version: original.version } },
    { cookie: f.cookie, body: { model: target, expected_version: 0 } },
    { cookie: f.cookie, body: { model: 'unpriced-model', expected_version: original.version } },
    { cookie: f.cookie, body: { model: target, expected_version: original.version, key: 'browser-supplied-key' } },
  ];
  for (const attempt of attempts) {
    const denied = await api(f.scoped, path, attempt.cookie, attempt.body);
    expect(denied.ok).toBe(false);
  }
  expect((await workspace(bindings, f.owner, { op: 'settings' })).providers).toHaveLength(2);
  const crossed = await bindings.SELF.fetch(`https://yoneda${path}`, { method: 'POST', headers: { cookie: f.cookie, origin: 'https://foreign.example' }, body: JSON.stringify({ model: target, expected_version: original.version }) });
  expect(crossed.status).toBe(401);
});
