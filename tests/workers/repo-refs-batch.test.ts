// Atomic multi-ref updates (`git push --atomic`) and repositories created with a policy.
import { expect, it } from 'vitest';
import { api, author, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

it('moves several branches in one transaction, or none when any is stale', async () => {
  const cookie = await signup('batcher');
  const created = await api('/repos', { cookie }, {
    body: { name: 'batch', files: [file('README.md', '# b\n')], author, tokens: [{ name: 'agent', scopes: ['read', 'write'] }, { name: 'ci', scopes: ['read', 'check'] }] },
  });
  const repo = `/repos/${created.body.id}`;
  const root = created.body.commit as string;
  const [agent, ci] = created.body.tokens.map((t: any) => ({ token: t.token }));
  const child = (await api(`${repo}/commits`, agent, { body: { parent: root, changes: [file('a.md', 'a\n')], message: 'a', author } })).body.commit;
  const batch = (who: object, updates: unknown[]) => api(`${repo}/refs/batch`, who, { body: { updates } });

  expect((await batch(ci, [{ ref: 'a', commit: root, expected: null }])).status).toBe(403);
  expect((await batch(agent, [{ ref: 'main', commit: child, expected: root }])).status).toBe(403);
  expect((await batch(agent, [])).status).toBe(400);
  expect((await api(`${repo}/refs/batch`, agent, { body: {} })).status).toBe(400);

  const applied = await batch(agent, [
    { ref: 'refs/heads/a', commit: root, expected: null },
    { ref: 'b', commit: child, expected: null },
  ]);
  expect(applied.status).toBe(200);
  expect(applied.body.refs.map((r: any) => [r.ref, r.commit])).toEqual([
    ['refs/heads/a', root],
    ['refs/heads/b', child],
  ]);
  expect(applied.body.version).toBe(3);

  const refused = await batch(agent, [
    { ref: 'a', commit: child, expected: root },
    { ref: 'b', commit: root, expected: root },
  ]);
  expect([refused.status, refused.body.error.code]).toEqual([409, 'STALE_HEAD']);
  expect(refused.body.error.details).toEqual({ stale: ['refs/heads/b'] });
  const refs = (await api(`${repo}/refs`, agent)).body.refs;
  expect([refs['refs/heads/a'], refs['refs/heads/b']]).toEqual([root, child]);
  expect((await api(repo, agent)).body.version).toBe(3);
});

it('creates a repository with a policy (solo: no approvals, no checks)', async () => {
  const cookie = await signup('solo_creator');
  const created = await api('/repos', { cookie }, {
    body: { name: 'solo', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author },
  });
  const repo = `/repos/${created.body.id}`;
  const next = await api(`${repo}/commits`, { cookie }, { body: { parent: created.body.commit, changes: [file('b.txt', 'b\n')], message: 'b', author } });
  const landed = await api(`${repo}/land`, { cookie }, { body: { ref: 'main', commit: next.body.commit } });
  expect([landed.status, landed.body.landed]).toEqual([200, true]);

  const strict = await api('/repos', { cookie }, { body: { name: 'strict', files: [file('a.txt', 'a\n')], author } });
  const other = await api(`/repos/${strict.body.id}/commits`, { cookie }, { body: { parent: strict.body.commit, changes: [file('b.txt', 'b\n')], message: 'b', author } });
  const blocked = await api(`/repos/${strict.body.id}/land`, { cookie }, { body: { ref: 'main', commit: other.body.commit } });
  expect(blocked.status).toBe(409);
  expect((await api('/repos', { cookie }, { body: { name: 'bad', policy: { approvals: -1 } } })).status).toBe(400);
});
