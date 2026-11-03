import { expect, it } from 'vitest';
import { encodeAccountIdentifier } from '../../shared/account';
import { sha } from '../../cloudflare/worker/storage';
import { workspace } from '../../cloudflare/worker/workspace';
import { withPath } from '../../cloudflare/worker/repo-paths';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';
import { applySchema } from './repo-fixture-schema';

usePlatformFixture();
const on = { ...scoped, JOINED_REPO_PATH: 'on' } as Env;
const repo = 'r0123456789abcdef0123';
const status = { name: 'current-name', viewer: { owner: true } };

async function row(index: D1Database, owner: string, handle?: string) {
  await index.prepare('INSERT INTO platform_repos(id,workspace,name,created_at) VALUES(?,?,?,?)').bind(repo, owner, 'stale-name', 1).run();
  if (handle !== undefined) await index.prepare('INSERT INTO platform_handles(workspace,handle) VALUES(?,?)').bind(owner, handle).run();
}
function counted(env: Env) {
  const sql: string[] = [];
  return { sql, env: { ...env, INDEX: new Proxy(env.INDEX, { get: (db, key) => key === 'prepare' ? (query: string) => { sql.push(query); return db.prepare(query); } : typeof Reflect.get(db, key) === 'function' ? Reflect.get(db, key).bind(db) : Reflect.get(db, key) }) } as Env };
}

it('decorates a fresh email-owned status with one local SQL query, not two serial queries', async () => {
  await row(bindings.INDEX, 'legacy.owner@example.com', 'legacy_owner');
  const observed = counted(on);
  const answer = await withPath(observed.env, repo, status);
  expect(answer).toMatchObject({ name: 'current-name', owner_handle: 'legacy_owner', path: '/legacy_owner/current-name' });
  expect(observed.sql).toHaveLength(1);
  expect(observed.sql[0]).toContain('LEFT JOIN');
  const old = counted({ ...on, JOINED_REPO_PATH: 'off' });
  expect(await withPath(old.env, repo, status)).toEqual(answer);
  expect(old.sql).toHaveLength(2);
});

it.each(['plain_owner', 'organization_owner'])('preserves username/org ownership for %s without requiring an alias', async (owner) => {
  await row(bindings.INDEX, owner);
  const observed = counted(on);
  expect(await withPath(observed.env, repo, status)).toEqual(await withPath(scoped, repo, status));
  expect(observed.sql).toHaveLength(1);
  expect((await withPath(on, repo, status)).path).toBe(`/${owner}/current-name`);
});

it('preserves absent listings and legacy owners without a handle', async () => {
  expect(await withPath(on, repo, status)).toEqual(await withPath(scoped, repo, status));
  expect((await withPath(on, repo, status)).path).toBeNull();
  await row(bindings.INDEX, 'unclaimed.owner@example.com');
  const observed = counted(on);
  expect(await withPath(observed.env, repo, status)).toMatchObject({ owner_handle: null, path: null });
  expect(observed.sql).toHaveLength(1);
  expect(await withPath(on, repo, status)).toEqual(await withPath(scoped, repo, status));
});

it('retains the existing home-cell fallback only when the local alias is missing', async () => {
  const europe = (bindings as unknown as { INDEX_WEUR: D1Database }).INDEX_WEUR;
  await applySchema(europe);
  const owner = 'regional.owner@example.com';
  await row(europe, owner);
  await bindings.INDEX.prepare('INSERT INTO platform_handles(workspace,handle) VALUES(?,?)').bind(owner, 'home_owner').run();
  const env = { ...on, INDEX: europe, INDEX_ENAM: bindings.INDEX, CELLS: 'on', CELL: 'weur' } as Env;
  expect(await withPath(env, repo, status)).toEqual(await withPath({ ...env, JOINED_REPO_PATH: 'off' }, repo, status));
  expect(await withPath(env, repo, status)).toMatchObject({ owner_handle: 'home_owner', path: '/home_owner/current-name' });
  await europe.prepare('INSERT INTO platform_handles(workspace,handle) VALUES(?,?)').bind(owner, 'local_owner').run();
  expect(await withPath(env, repo, status)).toMatchObject({ owner_handle: 'local_owner', path: '/local_owner/current-name' });
});

it('keeps status authorization fresh and uses the authority name after a stale projection', async () => {
  const owner = { cookie: await signup('metadata_owner') };
  const made = await api('/repos', owner, { body: { name: 'initial', files: [file('src/a.txt', 'a\n')], author, policy: { approvals: 0, required_checks: [] } } }, on);
  expect(made.status).toBe(200);
  const path = `/repos/${made.body.id}`;
  expect((await api(`${path}/name`, owner, { method: 'PUT', body: { name: 'renamed' } }, on)).status).toBe(200);
  await bindings.INDEX.prepare('UPDATE platform_repos SET name=? WHERE id=?').bind('stale-name', made.body.id).run();
  expect((await api(`${path}?summary=true`, owner, {}, on)).body).toMatchObject({ name: 'renamed', path: '/metadata_owner/renamed', viewer: { owner: true } });
  const outsider = { cookie: await signup('metadata_stranger') };
  expect((await api(`${path}?summary=true`, outsider, {}, on)).status).toBe(404);
  expect((await api(`${path}?summary=true`, {}, {}, on)).status).toBe(404);
  const minted = await api(`${path}/tokens`, owner, { body: { name: 'reader', scopes: ['read'], paths: ['src/'] } }, on);
  const reader = { token: minted.body.token };
  expect((await api(`${path}?summary=true`, reader, {}, on)).body.grant).toEqual(['src/']);
  expect((await api(`${path}/tokens/reader`, owner, { method: 'DELETE' }, on)).status).toBe(200);
  expect((await api(`${path}?summary=true`, reader, {}, on)).status).toBe(401);
  expect((await api(`${path}/visibility`, owner, { method: 'PUT', body: { visibility: 'public' } }, on)).status).toBe(200);
  expect((await api(`${path}?summary=true`, {}, {}, on)).body.viewer.public).toBe(true);
  expect((await api(`${path}?confirm=renamed`, owner, { method: 'DELETE' }, on)).status).toBe(200);
  const deleted = await api(`${path}?summary=true`, owner, {}, on);
  const previous = await api(`${path}?summary=true`, owner, {}, { ...on, JOINED_REPO_PATH: 'off' });
  expect([deleted.status, deleted.body]).toEqual([previous.status, previous.body]);
  expect(deleted.status).toBe(404);
});


it('keeps legacy email principals private for public readers of joined metadata', async () => {
  const email = 'metadata.public@example.com';
  const token = 'f'.repeat(64);
  await workspace(bindings, email, { op: 'signup', username: email, password: 'long platform test password', salt: '01'.repeat(16), session_hash: await sha(token), recovery_hash: 'b'.repeat(64) });
  const owner = { cookie: `yoneda_account=${encodeAccountIdentifier(email)}.${token}` };
  const made = await api('/repos', owner, { body: { name: 'public-alias', visibility: 'public', files: [file('a.txt', 'a\n')], author, policy: { approvals: 0, required_checks: [] } } }, on);
  expect(made.status).toBe(200);
  await bindings.INDEX.prepare('INSERT INTO platform_handles(workspace,handle) VALUES(?,?)').bind(email, 'public_alias').run();
  const path = `/repos/${made.body.id}?summary=true`;
  const publicView = await api(path, {}, {}, on);
  expect(publicView.status).toBe(200);
  expect(publicView.body).toMatchObject({ owner_handle: 'public_alias', path: '/public_alias/public-alias', viewer: { public: true } });
  expect(JSON.stringify(publicView.body)).not.toContain(email);
  const previous = await api(path, {}, {}, { ...on, JOINED_REPO_PATH: 'off' });
  expect([publicView.status, publicView.body]).toEqual([previous.status, previous.body]);
  expect(JSON.stringify((await api(path, owner, {}, on)).body)).toContain(email);
});
