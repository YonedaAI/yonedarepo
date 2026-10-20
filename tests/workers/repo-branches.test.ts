// Working branches and fast-forward-only landing through the public API and MCP.
import { expect, it } from 'vitest';
import { api, author, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

it('moves working branches by compare-and-swap and lands only the exact reviewed commit', async () => {
  const owner = { cookie: await signup('branch_owner') };
  const created = await api('/repos', owner, {
    body: { name: 'branches', policy: { required_checks: [], approvals: 1 }, files: [file('README.md', '# b\n')], author },
  });
  const repo = `/repos/${created.body.id}`;
  const root = created.body.commit as string;
  const agent = { token: (await api(`${repo}/tokens`, owner, { body: { name: 'agents', scopes: ['read', 'write', 'check'] } })).body.token };
  const commit = async (path: string) =>
    (await api(`${repo}/commits`, agent, { body: { parent: root, changes: [file(path, `${path}\n`)], message: path, author } })).body.commit as string;
  const first = await commit('a.md');
  const second = await commit('b.md');

  const create = await api(`${repo}/branches`, agent, { body: { ref: 'candidates/first', commit: first, expected: null } });
  expect(create.status).toBe(200);
  expect(create.body.ref).toBe('refs/heads/candidates/first');
  const stale = await api(`${repo}/branches`, agent, { body: { ref: 'candidates/first', commit: second, expected: null } });
  expect([stale.status, stale.body.error.code]).toEqual([409, 'STALE_HEAD']);
  expect((await api(`${repo}/branches`, agent, { body: { ref: 'main', commit: first, expected: root } })).status).toBe(403);
  const refs = await api(`${repo}/refs`, agent);
  expect(refs.body.refs['refs/heads/candidates/first']).toBe(first);
  // By name: diffs and logs address the working branch.
  const diff = await api(`${repo}/diff?base=main&head=candidates/first`, agent);
  expect(diff.body.changes.map((c: any) => c.path)).toEqual(['a.md']);

  // The agent token cannot land; the owner lands exactly the reviewed commit.
  for (const sha of [first, second])
    expect((await api(`${repo}/commits/${sha}/reviews`, owner, { body: { decision: 'approve' } })).status).toBe(200);
  expect((await api(`${repo}/land`, agent, { body: { ref: 'main', commit: first, fast_forward_only: true } })).status).toBe(403);
  const landed = await api(`${repo}/land`, owner, { body: { ref: 'main', commit: first, fast_forward_only: true } });
  expect(landed.body).toMatchObject({ landed: true, commit: first });
  const refused = await api(`${repo}/land`, owner, { body: { ref: 'main', commit: second, fast_forward_only: true } });
  expect([refused.status, refused.body.error.code]).toEqual([409, 'STALE_HEAD']);
  expect((await api(`${repo}/refs`, agent)).body.refs['refs/heads/main']).toBe(first);
});
