// Repository deletion: confirmed by name, it leaves a tombstone (reads and writes answer
// GONE, tokens revoked, listing row removed) and purges the object store in a platform job.
import { expect, it } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, drainObjects, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;

async function keys(prefix: string) {
  return (await bindings.OBJECTS.list({ prefix })).objects.map((o) => o.key);
}

it('deletes a repository into a tombstone and purges its objects', async () => {
  const cookie = await signup('deleter');
  const created = await api('/repos', { cookie }, {
    body: { name: 'doomed', files: [file('a.txt', 'a\n')], author, tokens: [{ name: 'agent', scopes: ['read', 'write'] }] },
  }, local);
  const id = created.body.id as string;
  const repo = `/repos/${id}`;
  const agent = { token: created.body.tokens[0].token as string };
  expect((await api(repo, agent, {}, local)).status).toBe(200);
  await drainObjects(local);
  expect((await keys(`platform/v1/${id}/`)).length).toBeGreaterThan(0);
  const reader = (await api('/tokens', { cookie }, { body: { name: 'r', scopes: ['repo:read', 'repo:write'] } })).body.token;
  const admin = (await api('/tokens', { cookie }, { body: { name: 'a', scopes: ['repo:admin'] } })).body.token;

  for (const query of ['', '?confirm=', '?confirm=other']) {
    const wrong = await api(`${repo}${query}`, { cookie }, { method: 'DELETE' }, local);
    expect([wrong.status, wrong.body.error.code]).toEqual([400, 'INVALID_INPUT']);
  }
  expect((await api(`${repo}?confirm=doomed`, { token: reader }, { method: 'DELETE' }, local)).status).toBe(403);
  expect((await api(`${repo}?confirm=doomed`, agent, { method: 'DELETE' }, local)).status).toBe(403);
  const deleted = await api(`${repo}?confirm=doomed`, { token: admin }, { method: 'DELETE' }, local);
  expect([deleted.status, deleted.body]).toEqual([200, { deleted: true }]);

  for (const [who, path, init] of [
    [{ cookie }, repo, {}],
    [{ cookie }, `${repo}/tree?path=`, {}],
    [agent, `${repo}/refs`, {}],
    [{ token: reader }, `${repo}/log`, {}],
    [agent, `${repo}/commits`, { body: { parent: created.body.commit, changes: [file('b.txt', 'b\n')], message: 'b', author } }],
  ] as const) {
    const gone = await api(path, who, init, local);
    expect([gone.status, gone.body.error.code], path).toEqual([404, 'GONE']);
  }
  expect((await api('/repos', { cookie })).body.repos).toEqual([]);
  // Retrying is safe and queues the purge again.
  expect((await api(`${repo}?confirm=doomed`, { cookie }, { method: 'DELETE' }, local)).body).toEqual({ deleted: true });

  const purges = queued.filter((m) => m.kind === 'platform_purge' && m.repo_id === id);
  expect(purges.length).toBe(2);
  let acked = 0;
  await platformJob(local, { body: purges[0], attempts: 1, ack: () => void acked++, retry: () => {} } as unknown as Message<any>);
  expect(acked).toBe(1);
  expect(await keys(`store/v1/yr-${id}/`)).toEqual([]);
  expect(await keys(`platform/v1/${id}/`)).toEqual([]);
  // Purging twice is a no-op.
  await platformJob(local, { body: purges[1], attempts: 1, ack: () => void acked++, retry: () => {} } as unknown as Message<any>);
  expect(acked).toBe(2);
});

it('lets the owner session delete, and nobody else', async () => {
  const cookie = await signup('owner_deleter');
  const id = (await api('/repos', { cookie }, { body: { name: 'mine' } })).body.id;
  const other = await signup('other_deleter');
  expect((await api(`/repos/${id}?confirm=mine`, { cookie: other }, { method: 'DELETE' })).status).toBe(403);
  expect((await api(`/repos/${id}?confirm=mine`, { cookie }, { method: 'DELETE' })).body).toEqual({ deleted: true });
  expect((await api(`/repos/${id}`, { cookie })).body.error.code).toBe('GONE');
});
