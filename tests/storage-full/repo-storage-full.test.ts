// A database that really stops growing, in workerd: a write past the limit breaks the Durable
// Object's instance, so the failure is thrown out of the call past the Rust adapter (it never
// answers `DATABASE`). Clients get 507 REPO_FULL, and the next instance serves them again.
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { api, author, bindings, file, signup, usePlatformFixture } from '../workers/repo-fixture';

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
  // Nothing of the write stayed, and the repository answers again.
  const refs = await api(`/repos/${id}/refs`, owner);
  expect(refs.status).toBe(200);
  expect(Object.keys(refs.body.refs)).toEqual(['refs/heads/main']);
  expect((await api(`/repos/${id}/blob?path=a.txt`, owner)).body.content).toBe('0\n');
});
