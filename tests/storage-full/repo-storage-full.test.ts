// A database that really stops growing, in workerd: a write past the limit breaks the Durable
// Object's instance, so the failure is thrown out of the call past the Rust adapter (it never
// answers `DATABASE`). Clients get 507 REPO_FULL, and the next instance serves them again.
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { REPO_FULL_MESSAGE } from '../../cloudflare/worker/durable';
import { projectChangesets } from '../../cloudflare/worker/repo-changesets';
import { caller } from '../../cloudflare/worker/repo-ops';
import { shardRecord } from '../../cloudflare/worker/repo-shards';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from '../workers/repo-fixture';

usePlatformFixture();

type Limited = SqlStorage & { setMaxPageCountForTest(pages: number): void };

it('answers 507 REPO_FULL for a write the database refuses, then serves the repository again', async () => {
  const owner = { cookie: await signup('filled') };
  const created = await api('/repos', owner, { body: { name: 'filled', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } });
  const id = created.body.id as string;
  const stub = bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(id));
  await runInDurableObject(stub, (_: unknown, state: DurableObjectState) => {
    const sql = state.storage.sql as Limited;
    sql.setMaxPageCountForTest(Math.ceil(sql.databaseSize / 4096));
  });
  const updates = Array.from({ length: 100 }, (_, i) => ({ ref: `b${i}`, commit: created.body.commit, expected: null }));
  const refused = await api(`/repos/${id}/refs/batch`, owner, { body: { updates } });
  expect(refused.status).toBe(507);
  expect(refused.body.error.code).toBe('REPO_FULL');
  expect(refused.body.error.message).toBe(REPO_FULL_MESSAGE);
  // Nothing of the write stayed, and the repository answers again.
  const refs = await api(`/repos/${id}/refs`, owner);
  expect(refs.status).toBe(200);
  expect(Object.keys(refs.body.refs)).toEqual(['refs/heads/main']);
  expect((await api(`/repos/${id}/blob?path=a.txt`, owner)).body.content).toBe('0\n');
});

// The room between the guard and the database's own limit is what accepted work finishes in:
// here 1 MB of it, with the guard at the size the repository already is.
it('finishes accepted work between the cap and the database limit, and takes no new work there', async () => {
  const batched = { ...scoped, LAND_MODE: 'batch' } as unknown as Env;
  const owner = { cookie: await signup('capped') };
  const created = await api('/repos', owner, {
    body: { name: 'capped', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author, tokens: [{ name: 'agent', scopes: ['read', 'write', 'land', 'check'] }] },
  }, batched);
  const id = created.body.id as string;
  const commitOf = (path: string, target: Env) => api(`/repos/${id}/commits`, owner, { body: { ref: 'main', changes: [file(path, `${path}\n`)], message: path, author } }, target);
  const commit = (await commitOf('b.txt', batched)).body.commit as string;
  const items = [{ credentials: caller(batched, id, { _token: created.body.tokens[0].token }).sign({}), records: [await shardRecord(batched, id, commit)] }];
  expect((await caller(batched, id, { _system: 'merge' })({ op: 'repo_land_submitted', ref: 'main', items })).items[0].status).toBe('landed');
  const stub = bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(id));
  const size = (await caller(batched, id, { _system: 'derive' })({ op: 'repo_storage' })).db_bytes as number;
  await runInDurableObject(stub, (_: unknown, state: DurableObjectState) => {
    (state.storage.sql as Limited).setMaxPageCountForTest(Math.ceil(size / 4096) + 256);
  });
  const capped = { ...batched, LAND_COMBINERS: undefined, REPO_STORAGE_GUARD: String(size) } as unknown as Env;
  expect(await projectChangesets(capped, id)).toBe(1);
  expect((await api(`/repos/${id}/blob?path=b.txt`, owner, {}, capped)).body.content).toBe('b.txt\n');
  const refused = await commitOf('c.txt', capped);
  expect(refused.status).toBe(507);
  expect(refused.body.error.message).toBe(REPO_FULL_MESSAGE);
});
