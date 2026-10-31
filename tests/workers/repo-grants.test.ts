// N7 exit gate: a path-restricted token sees and changes only its grant, through every
// read path (tree, file, diff, search, blame, symbols, objects, log) and every write path,
// including after the owner warmed every cache tier with the hidden content.
import { expect, it } from 'vitest';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';
import type { Env } from '../../cloudflare/worker/types';

usePlatformFixture();

it('isolates hidden paths across reads, writes, caches and object tickets', async () => {
  const owner = { cookie: await signup('granter') };
  const files = [file('public/app.ts', 'export const greeting = "hello";\n'), file('secret/keys.ts', 'export const apiKey = "hunter2-greeting";\n')];
  const created = await api('/repos', owner, { body: { name: 'g', policy: { required_checks: [], approvals: 0 }, files, author } });
  const repo = `/repos/${created.body.id}`;
  const head = created.body.commit as string;
  const minted = await api(`${repo}/tokens`, owner, { body: { name: 'contractor', scopes: ['read', 'write', 'land'], paths: ['public/'] } });
  expect(minted.body.paths).toEqual(['public/']);
  const contractor = { token: minted.body.token as string };

  // The owner warms every tier with the hidden content first.
  const secret = await api(`${repo}/blob?path=secret/keys.ts`, owner);
  expect(secret.body.content).toContain('hunter2');
  expect((await api(`${repo}/search?query=greeting`, owner)).body.results).toHaveLength(2);
  expect((await api(`${repo}/symbols?path=secret/keys.ts`, owner)).status).toBe(200);
  const rootTree = (await api(`${repo}/tree?path=`, owner)).body;

  const forbidden = async (path: string) => {
    const result = await api(path, contractor);
    expect(result.status, path).toBe(403);
    expect(result.body.error.message).toBe('Path is outside your grant');
  };
  // Hidden paths are refused uniformly, whether or not they exist.
  await forbidden(`${repo}/blob?path=secret/keys.ts`);
  await forbidden(`${repo}/blob?path=secret/missing.ts`);
  await forbidden(`${repo}/tree?path=secret`);
  await forbidden(`${repo}/blame?path=secret/keys.ts`);
  await forbidden(`${repo}/symbols?path=secret/keys.ts`);
  await forbidden(`${repo}/log?ref=main&path=secret/keys.ts`);
  expect((await api(`${repo}/tree?path=`, contractor)).body.entries.map((e: any) => e.name)).toEqual(['public']);
  expect((await api(`${repo}/blob?path=public/app.ts`, contractor)).body.content).toContain('hello');

  // Search filters before reading or counting: no hidden hits, nothing to rank.
  const search = await api(`${repo}/search?query=greeting`, contractor);
  expect(search.body.results.map((r: any) => r.path)).toEqual(['public/app.ts']);

  // Object tickets: no bare-id lookups (a content oracle); paths must be inside the grant.
  const secretBlob = (await api(`${repo}/tree?path=secret`, owner)).body.entries[0].id;
  const byId = await api(`${repo}/objects`, contractor, { body: { objects: [{ id: secretBlob, kind: 'blob' }] } });
  expect(byId.status).toBe(403);
  const byHiddenPath = await api(`${repo}/objects`, contractor, { body: { commit: head, objects: [{ id: secretBlob, kind: 'blob', path: 'secret/keys.ts' }] } });
  expect(byHiddenPath.status).toBe(403);
  const disguised = await api(`${repo}/objects`, contractor, { body: { commit: head, objects: [{ id: secretBlob, kind: 'blob', path: 'public/app.ts' }] } });
  expect(disguised.status).toBe(403);
  const publicBlob = (await api(`${repo}/tree?path=public`, contractor)).body.entries[0].id;
  const allowed = await api(`${repo}/objects`, contractor, { body: { commit: head, objects: [{ id: publicBlob, kind: 'blob', path: 'public/app.ts' }] } });
  expect(allowed.body.objects).toHaveLength(1);
  expect((await api(`${repo}/objects`, contractor, { body: { commit: head, objects: [{ id: rootTree.entries[0].id, kind: 'tree', path: '' }] } })).status).toBe(403);

  // Writes outside the grant are refused; diffs and log entries show only granted paths.
  const outside = await api(`${repo}/commits`, contractor, { body: { ref: 'main', changes: [file('secret/keys.ts', 'x')], message: 'x', author } });
  expect(outside.status).toBe(403);
  const mixed = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('public/app.ts', 'v2\n'), file('secret/keys.ts', 'v2\n')], message: 'both', author } });
  const diff = await api(`${repo}/diff?head=${mixed.body.commit}&patch=1`, contractor);
  expect(diff.body.changes.map((c: any) => c.path)).toEqual(['public/app.ts']);
  expect((await api(`${repo}/commits/${mixed.body.commit}`, contractor)).body.paths.map((p: any) => p.path)).toEqual(['public/app.ts']);
  expect((await api(`${repo}/land`, contractor, { body: { ref: 'main', commit: mixed.body.commit } })).status).toBe(403);
  const codemod = await api(`${repo}/codemods`, contractor, { body: { find: 'greeting', replace: 'salute', author } });
  expect(codemod.body.touches.map((t: any) => t.path)).toEqual(['public/app.ts']);
});

// Commits are in their shards here, so the authority sees the chain only through the adapter.
it.each(['batch', 'changeset'])('judges all a landing would bring in %s mode', async (mode) => {
  const target = { ...scoped, LAND_MODE: mode } as unknown as Env;
  const owner = { cookie: await signup(`chain-${mode}`) };
  const files = [file('public/app.ts', 'a\n'), file('secret/keys.ts', 'b\n')];
  const created = await api('/repos', owner, { body: { name: 'g', policy: { required_checks: [], approvals: 0 }, files, author } }, target);
  const repo = `/repos/${created.body.id}`;
  const head = created.body.commit as string;
  const minted = await api(`${repo}/tokens`, owner, { body: { name: 'contractor', scopes: ['read', 'write', 'land'], paths: ['public/'] } }, target);
  const contractor = { token: minted.body.token as string };
  const commit = async (who: object, parent: string, path: string) =>
    (await api(`${repo}/commits`, who, { body: { parent, base_version: 1, changes: [file(path, 'x\n')], message: path, author } }, target)).body.commit as string;
  const land = (who: object, sha: string) => api(`${repo}/land`, who, { body: { ref: 'main', commit: sha } }, target);

  const hidden = await commit(owner, head, 'secret/more.ts');
  const onTop = await commit(contractor, hidden, 'public/on-top.ts');
  expect((await land(contractor, hidden)).status).toBe(403);
  const refused = await land(contractor, onTop);
  expect([refused.status, refused.body.error?.message]).toEqual([403, 'Path is outside your grant']);
  expect((await api(`${repo}/blob?path=secret/more.ts`, owner, {}, target)).status).toBe(404);

  // Work inside the grant lands, a chain included, and the owner lands the refused one.
  const first = await commit(contractor, head, 'public/first.ts');
  const second = await commit(contractor, first, 'public/second.ts');
  expect((await land(contractor, second)).body.landed).toBe(true);
  expect((await land(owner, onTop)).body.landed).toBe(true);
  expect((await api(`${repo}/blob?path=secret/more.ts`, owner, {}, target)).status).toBe(200);
});
