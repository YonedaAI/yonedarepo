import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { Env, Json } from '../../cloudflare/worker/types';
import { providerCredentials, seal } from '../../cloudflare/worker/vault';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, bindings, signup } from './reviewer-fixture';

const path = '/api/admin/reviewer/managed-mimo';
const flash = 'mimo-v2.6-flash';
const pro = 'mimo-v2.6-pro';
afterEach(async () => {
  await reset();
});

async function fixture(key = 'synthetic-managed-mimo') {
  const owner = 'mimo_reviewer';
  const cookie = await signup(owner);
  await workspace(bindings, owner, {
    op: 'reviewer_configure',
    repo_id: 'existing-reviewer',
    expires: Date.now() + 86400000,
  });
  // Only Secrets Store is simulated; vault and Rust/Wasm Workspace DO SQLite are real.
  const get = vi.fn(async () => key);
  const scoped = { ...bindings, MIMO_KEY: { get } } as unknown as Env;
  return { owner, cookie, get, scoped };
}
async function preserved(owner: string) {
  return Promise.all(
    ['reviewer_status', 'budget_status', 'workspace_spend_status', 'projects'].map((op) =>
      workspace(bindings, owner, { op }),
    ),
  );
}
async function providers(owner: string) {
  return (await workspace(bindings, owner, { op: 'settings' })).providers as Json[];
}
async function saved(
  owner: string,
  connection: string,
  model: string,
  key: string,
  routing?: Json,
) {
  return workspace(bindings, owner, {
    op: 'provider_put',
    provider: 'mimo',
    connection,
    model,
    routing,
    sealed: await seal(bindings, owner, 'mimo', key, connection),
  });
}

it('adds managed Flash/Pro once, preserves all existing versions and reviewer/funding state', async () => {
  const f = await fixture();
  await workspace(bindings, f.owner, {
    op: 'provider_put',
    provider: 'claude',
    connection: 'existing-claude',
    model: 'claude-sonnet-5-5',
    sealed: await seal(bindings, f.owner, 'claude', 'fixture', 'existing-claude'),
  });
  const before = await preserved(f.owner);
  const existing = await providers(f.owner);
  const first = await api(f.scoped, path, '', { username: f.owner }, true);
  expect(first.status).toBe(200);
  const result = await first.json<Json>();
  expect(result).toEqual({
    models: [
      { connection: 'reviewer-mimo-flash-2-6', model: flash },
      { connection: 'reviewer-mimo-pro-2-6', model: pro },
    ],
  });
  expect(JSON.stringify(result)).not.toMatch(
    /sealed|ciphertext|synthetic-managed-mimo|routing|username/,
  );
  const after = await providers(f.owner);
  expect(after.find((p) => p.id === 'existing-claude')).toEqual(existing[0]);
  expect((await api(f.scoped, path, '', { username: f.owner }, true)).status).toBe(200);
  expect(await providers(f.owner)).toEqual(after);
  expect(f.get).toHaveBeenCalledTimes(1);
  expect(await preserved(f.owner)).toEqual(before);
  expect((await api(f.scoped, '/api/auth/session', f.cookie)).status).toBe(200);
});

it('reuses a saved Token Plan source, pins its alias version and never reads the managed key', async () => {
  const f = await fixture();
  const routing = { plan: 'token_plan', region: 'ams' };
  const source = await saved(f.owner, 'existing-mimo', flash, 'tp-synthetic-existing', routing);
  f.get.mockImplementation(async () => {
    throw new Error('Managed key must remain unread');
  });
  const first = await api(f.scoped, path, '', { username: f.owner }, true);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({
    models: [
      { connection: 'existing-mimo', model: flash },
      { connection: 'reviewer-mimo-pro-2-6', model: pro },
    ],
  });
  const after = await providers(f.owner);
  expect(after.find((p) => p.id === 'existing-mimo')?.version).toBe(source.version);
  expect(after.find((p) => p.model === pro)).toMatchObject({
    routing,
    alias_source: { connection: 'existing-mimo', version: source.version },
  });
  const credentials = await providerCredentials(
    f.scoped,
    f.owner,
    'mimo',
    'reviewer-mimo-pro-2-6',
    pro,
    routing,
  );
  expect(credentials.routing).toEqual(routing);
  expect(credentials.key.startsWith('tp-')).toBe(true);
  expect((await api(f.scoped, path, '', { username: f.owner }, true)).status).toBe(200);
  expect(await providers(f.owner)).toEqual(after);
  expect(f.get).not.toHaveBeenCalled();
});

it('rejects non-admin, non-reviewer, revoked/expired, non-POST and caller-key requests before secrets', async () => {
  const f = await fixture();
  const input = { username: f.owner };
  expect((await api(f.scoped, path, '', input)).status).toBe(401);
  expect((await api(f.scoped, path, f.cookie, input)).status).toBe(403);
  expect((await api(f.scoped, path, '', undefined, true)).status).toBe(404);
  expect((await api(f.scoped, path, '', { ...input, key: 'caller-key' }, true)).status).toBe(400);
  await signup('ordinary_owner');
  expect((await api(f.scoped, path, '', { username: 'ordinary_owner' }, true)).status).toBe(403);
  const stub = bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${f.owner}`));
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE workspace_records SET payload=json_set(payload,'$.expires',1) WHERE id='reviewer_policy'",
    );
  });
  expect((await api(f.scoped, path, '', input, true)).status).toBe(403);
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE workspace_records SET payload=json_set(payload,'$.expires',?) WHERE id='reviewer_policy'",
      Date.now() + 86400000,
    );
  });
  await workspace(bindings, f.owner, { op: 'reviewer_revoke' });
  expect((await api(f.scoped, path, '', input, true)).status).toBe(403);
  expect(await providers(f.owner)).toEqual([]);
  expect(f.get).not.toHaveBeenCalled();
});

it('requires the managed Token Plan region before any write and rejects route/identity drift', async () => {
  const f = await fixture('tp-synthetic-managed');
  for (const routing of [
    undefined,
    { plan: 'token_plan' },
    { plan: 'token_plan', region: 'guess' },
  ]) {
    const result = await api(
      f.scoped,
      path,
      '',
      { username: f.owner, ...(routing ? { routing } : {}) },
      true,
    );
    expect(result.status).not.toBe(200);
    expect(await providers(f.owner)).toEqual([]);
  }
  const routing = { plan: 'token_plan', region: 'sgp' };
  await workspace(bindings, f.owner, {
    op: 'provider_put',
    provider: 'claude',
    connection: 'reviewer-mimo-pro-2-6',
    model: 'claude-sonnet-5-5',
    sealed: await seal(bindings, f.owner, 'claude', 'fixture', 'reviewer-mimo-pro-2-6'),
  });
  const collision = await providers(f.owner);
  expect((await api(f.scoped, path, '', { username: f.owner, routing }, true)).status).toBe(409);
  expect(await providers(f.owner)).toEqual(collision);
  await workspace(bindings, f.owner, {
    op: 'provider_delete',
    connection: 'reviewer-mimo-pro-2-6',
  });
  expect((await api(f.scoped, path, '', { username: f.owner, routing }, true)).status).toBe(200);
  const after = await providers(f.owner);
  expect(after.every((p) => p.routing.plan === 'token_plan' && p.routing.region === 'sgp')).toBe(
    true,
  );
  expect(
    (await api(f.scoped, path, '', { username: f.owner, routing: { plan: 'api_credits' } }, true))
      .status,
  ).toBe(409);
  expect(await providers(f.owner)).toEqual(after);
  await workspace(bindings, f.owner, {
    op: 'provider_delete',
    connection: 'reviewer-mimo-pro-2-6',
  });
  const retry = await api(f.scoped, path, '', { username: f.owner, routing }, true);
  expect(retry.status).toBe(409); // Retired immutable alias identity cannot be resurrected.
  expect(await providers(f.owner)).toHaveLength(1);
});
