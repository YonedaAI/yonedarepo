import { expect, it } from 'vitest';
import { repositoryQuery, sortedRepositories } from '../../cloudflare/worker/platform-admin-repositories';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { inScope } from '../../cloudflare/worker/request-scope';
import type { Env } from '../../cloudflare/worker/types';
import { applySchema } from './repo-fixture-schema';
import { api, bindings, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const owner = { token: 'local-test-owner' };
const id = (n: number) => `r${n.toString(16).padStart(20, '0')}`;
async function seed() {
  await bindings.INDEX.prepare('INSERT INTO platform_handles(handle,workspace) VALUES(?,?)')
    .bind('aliased', 'owner@example.com').run();
  for (let i = 0; i < 63; i++) {
    await bindings.INDEX.prepare('INSERT INTO platform_repos(id,workspace,name,created_at,visibility) VALUES(?,?,?,?,?)')
      .bind(id(i), i % 2 ? 'owner@example.com' : 'other', `repo-${String(i).padStart(2, '0')}`, 1000, i % 2 ? 'public' : 'private').run();
    if (i < 60) await bindings.INDEX.prepare('INSERT INTO platform_activity(repo,db_bytes) VALUES(?,?)')
      .bind(id(i), Math.floor(i / 2) * 1000).run();
  }
}
it('sorts the entire matching set before paging, with ties and unknown samples', async () => {
  await seed();
  const first = await api('/admin/repos?sort=database&direction=desc', owner);
  expect(first.status).toBe(200);
  expect(first.body.items[0]).toMatchObject({ id: id(58), db_bytes: 29000 });
  expect(first.body.items).toHaveLength(50);
  expect(typeof first.body.next).toBe('string');
  const second = await api(`/admin/repos?sort=database&direction=desc&cursor=${encodeURIComponent(first.body.next)}`, owner);
  expect(second.body.next).toBeNull();
  expect(second.body.items.slice(-3).map((r: any) => r.db_bytes)).toEqual([null, null, null]);
  expect(new Set([...first.body.items, ...second.body.items].map((r: any) => r.id)).size).toBe(63);
  const ascending = await api('/admin/repos?sort=database&direction=asc', owner);
  expect(ascending.body.items[0]).toMatchObject({ id: id(0), db_bytes: 0 });
});
it('keeps search, sort and direction scoped to the cursor and validates untrusted ordering', async () => {
  await seed();
  const searched = await api('/admin/repos?sort=name&direction=asc&q=aliased', owner);
  expect(searched.body.items).toHaveLength(31);
  expect(searched.body.items[0].name).toBe('repo-01');
  const first = (await api('/admin/repos?sort=name&direction=asc', owner)).body;
  for (const query of [
    'sort=name%20DESC', 'sort=name&direction=sideways', 'sort=name&cursor=garbage',
    `sort=created&direction=asc&cursor=${encodeURIComponent(first.next)}`,
    `sort=name&direction=asc&q=changed&cursor=${encodeURIComponent(first.next)}`,
  ]) expect((await api(`/admin/repos?${query}`, owner)).status, query).toBe(400);
  expect((await api('/admin/repos?sort=database', {})).status).toBe(401);
  const user = await signup('not_an_operator');
  expect((await api('/admin/repos?sort=database', { cookie: user })).status).toBe(403);
});

it('merges real per-cell D1 pages globally and continues past tied keys without losing rows', async () => {
  await seed();
  const europe = (bindings as unknown as { INDEX_WEUR: D1Database }).INDEX_WEUR;
  await applySchema(europe);
  for (let n = 100; n < 163; n++) {
    await europe.prepare('INSERT INTO platform_repos(id,workspace,name,created_at,visibility) VALUES(?,?,?,?,?)')
      .bind(id(n), 'europe', `repo-${n}`, 1000, 'private').run();
    await europe.prepare('INSERT INTO platform_activity(repo,db_bytes) VALUES(?,?)').bind(id(n), 30000).run();
  }
  const eu = { ...scoped, CELLS: 'on', CELL: 'weur', INDEX: europe } as Env;
  const target = { ...scoped, CELLS: 'on', CELL_WEUR: {
    fetch: (req: Request) => inScope({ env: eu, req }, () => platformFetch(req, eu)),
  } } as unknown as Env;
  for (const sort of ['database', 'created', 'name', 'owner', 'visibility']) for (const direction of ['asc', 'desc']) {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ sort, direction });
      if (cursor) params.set('cursor', cursor);
      const answer = await api(`/admin/repos?${params}`, owner, {}, target);
      expect(answer.status).toBe(200);
      expect(answer.body.partial).toBeUndefined();
      seen.push(...answer.body.items.map((r: any) => r.id));
      cursor = answer.body.next;
      expect(seen.length).toBeLessThanOrEqual(126);
    } while (cursor);
    expect(new Set(seen).size, `${sort} ${direction}`).toBe(126);
    if (sort === 'database' && direction === 'desc') expect(seen.slice(0, 63)).toEqual(Array.from({ length: 63 }, (_, i) => id(100 + i)));
  }
  const failed = { ...target, CELL_WEUR: { fetch: async () => new Response('{}', { status: 503 }) } } as unknown as Env;
  expect((await api('/admin/repos?sort=database', owner, {}, failed)).body.partial).toBe(true);
});
it('escapes search wildcards and retains the old no-sort listing protocol', async () => {
  await seed();
  expect((await api('/admin/repos?sort=name&q=%25', owner)).body.items).toEqual([]);
  expect((await api('/admin/repos?sort=name&q=repo-01', owner)).body.items).toHaveLength(1);
  expect((await api(`/admin/repos?sort=name&q=${id(5)}`, owner)).body.items[0].id).toBe(id(5));
  const legacy = (await api('/admin/repos', owner)).body;
  expect(typeof legacy.next).toBe('number');
  expect(legacy.items[0]).not.toHaveProperty('sort_value');
});

it('searches and orders a remote legacy owner by the handle kept in its home directory', async () => {
  await seed();
  const europe = (bindings as unknown as { INDEX_WEUR: D1Database }).INDEX_WEUR;
  await applySchema(europe);
  await europe.prepare('INSERT INTO platform_repos(id,workspace,name,created_at,visibility) VALUES(?,?,?,?,?)')
    .bind(id(200), 'owner@example.com', 'remote-legacy', 1000, 'private').run();
  await europe.prepare('INSERT INTO platform_handles(workspace,handle) VALUES(?,?)')
    .bind('owner@example.com', 'old_alias').run();
  await europe.prepare('INSERT INTO platform_repos(id,workspace,name,created_at,visibility) VALUES(?,?,?,?,?)')
    .bind(id(201), 'another@example.com', 'missing-alias', 1000, 'private').run();
  await bindings.INDEX.prepare('INSERT INTO platform_handles(workspace,handle) VALUES(?,?)')
    .bind('another@example.com', 'other_alias').run();
  const eu = { ...scoped, CELLS: 'on', CELL: 'weur', INDEX: europe, INDEX_ENAM: bindings.INDEX } as Env;
  const target = { ...scoped, CELLS: 'on', CELL_WEUR: {
    fetch: (req: Request) => inScope({ env: eu, req }, () => platformFetch(req, eu)),
  } } as unknown as Env;
  const found = await api('/admin/repos?sort=owner&direction=asc&q=aliased', owner, {}, target);
  expect(found.body.items).toHaveLength(32);
  expect(found.body.items.find((r: any) => r.id === id(200))).toMatchObject({ handle: 'aliased', sort_value: 'aliased' });
  const ordered = (await api('/admin/repos?sort=owner&direction=asc', owner, {}, target)).body.items;
  expect(ordered.slice(0, 32).every((r: any) => r.handle === 'aliased')).toBe(true);
  expect((await api('/admin/repos?sort=owner&q=old_alias', owner, {}, target)).body.items).toEqual([]);
  expect((await api('/admin/repos?sort=owner&q=other_alias', owner, {}, target)).body.items[0].id).toBe(id(201));
});

it('fails clearly rather than truncate an oversized or unavailable legacy handle directory', async () => {
  const cap = { prepare: () => ({ bind: () => ({ all: async () => ({ results: Array.from({ length: 501 }, (_, i) => ({ workspace: `legacy${i}@example.com` })) }) }) }) } as unknown as D1Database;
  const order = repositoryQuery(new URLSearchParams('sort=owner'));
  await expect(sortedRepositories({ ...scoped, CELLS: 'on', CELL: 'weur', INDEX: cap } as Env, order))
    .rejects.toMatchObject({ code: 'CELL_UNAVAILABLE' });
  await seed();
  await expect(sortedRepositories({ ...scoped, CELLS: 'on', CELL: 'weur', INDEX_ENAM: undefined } as Env, order))
    .resolves.toBeDefined(); // A locally projected alias needs no remote directory.
  await bindings.INDEX.prepare('DELETE FROM platform_handles').run();
  await expect(sortedRepositories({ ...scoped, CELLS: 'on', CELL: 'weur', INDEX_ENAM: undefined } as Env, order))
    .rejects.toMatchObject({ code: 'CELL_UNAVAILABLE' });
});

it('filters exact owners and visibility across all cells before sorted pagination', async () => {
  await seed();
  const europe = (bindings as unknown as { INDEX_WEUR: D1Database }).INDEX_WEUR;
  await applySchema(europe);
  for (let n = 100; n < 163; n++) {
    await europe.prepare('INSERT INTO platform_repos(id,workspace,name,created_at,visibility) VALUES(?,?,?,?,?)')
      .bind(id(n), 'owner@example.com', `repo-${n}`, 1000, n % 2 ? 'private' : 'public').run();
    await europe.prepare('INSERT INTO platform_activity(repo,db_bytes) VALUES(?,?)').bind(id(n), 30000).run();
  }
  const eu = { ...scoped, CELLS: 'on', CELL: 'weur', INDEX: europe, INDEX_ENAM: bindings.INDEX } as Env;
  const target = { ...scoped, CELLS: 'on', CELL_WEUR: {
    fetch: (req: Request) => inScope({ env: eu, req }, () => platformFetch(req, eu)),
  } } as unknown as Env;
  for (const name of ['@ALIASED', 'OWNER@example.com']) {
    const query = new URLSearchParams({ sort: 'database', direction: 'desc', owner: name, visibility: 'public' });
    const seen: any[] = [];
    let cursor: string | null = null;
    do {
      if (cursor) query.set('cursor', cursor);
      const answer = await api(`/admin/repos?${query}`, owner, {}, target);
      expect(answer.status).toBe(200);
      expect(answer.body.partial).toBeUndefined();
      seen.push(...answer.body.items);
      cursor = answer.body.next;
      expect(seen.length).toBeLessThanOrEqual(63);
    } while (cursor);
    expect(new Set(seen.map(r => r.id)).size).toBe(63);
    expect(seen.every(r => r.visibility === 'public' && r.owner === 'owner@example.com')).toBe(true);
    expect(seen.slice(0, 32).every(r => r.db_bytes === 30000)).toBe(true);
  }
  expect((await api('/admin/repos?owner=aliased&visibility=private', owner, {}, target)).body.items).toHaveLength(31);
  expect((await api('/admin/repos?sort=name&owner=alias', owner, {}, target)).body.items).toEqual([]);
  expect((await api('/admin/repos?sort=name&owner=aliased&visibility=public&q=repo-01', owner, {}, target)).body.items).toHaveLength(1);
  const first = (await api('/admin/repos?sort=name&owner=aliased&visibility=public', owner, {}, target)).body;
  expect(first.next).not.toBeNull();
  for (const filters of ['owner=other&visibility=public', 'owner=aliased&visibility=private', 'owner=aliased', 'visibility=public'])
    expect((await api(`/admin/repos?sort=name&${filters}&cursor=${encodeURIComponent(first.next)}`, owner, {}, target)).status).toBe(400);
});

it('rejects invalid or unsupported filters without accepting legacy cursors into filtered lists', async () => {
  await seed();
  const first = (await api('/admin/repos?sort=name', owner)).body;
  for (const query of ['owner=not%20an%20owner', 'visibility=internal', 'sort=name&created_after=1', 'created_after=1', 'sort=name&owner=one&owner=two', `sort=name&owner=aliased&cursor=${encodeURIComponent(first.next)}`])
    expect((await api(`/admin/repos?${query}`, owner)).status, query).toBe(400);
  expect((await api(`/admin/repos?sort=name&cursor=${encodeURIComponent(first.next)}`, owner)).status).toBe(200);
});

it('retains the legacy q/before protocol, including first-value duplicate semantics', async () => {
  await seed();
  const first = await api('/admin/repos?q=repo&before=1001', owner);
  expect(first.status).toBe(200);
  expect(first.body.items).toHaveLength(50);
  expect(first.body.next).toBe(1000);
  expect(first.body.items[0]).not.toHaveProperty('sort_value');
  expect((await api('/admin/repos?q=repo&before=1000', owner)).body.items).toEqual([]);
  expect((await api('/admin/repos?q=repo-01&q=repo-02', owner)).body.items.map((r: any) => r.name)).toEqual(['repo-01']);
  expect((await api('/admin/repos?q=repo&before=1001&before=1000', owner)).body.items).toHaveLength(50);
});
