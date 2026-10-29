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

it('issues repository tokens with the repository, and only the operator creates for another workspace', async () => {
  const owner = { cookie: await signup('token_owner') };
  const created = await api('/repos', owner, {
    body: { name: 'with-token', files: [file('README.md', 'x\n')], author, tokens: [{ name: 'agents', scopes: ['read', 'write', 'check'] }] },
  });
  expect(created.status).toBe(200);
  const [issued] = created.body.tokens;
  expect(issued).toMatchObject({ name: 'agents', scopes: ['read', 'write', 'check'] });
  expect(issued.token).toMatch(/^yrp_/);
  const repo = `/repos/${created.body.id}`;
  expect((await api(repo, { token: issued.token })).status).toBe(200);
  expect((await api(`${repo}/land`, { token: issued.token }, { body: { ref: 'main', commit: created.body.commit } })).status).toBe(403);

  const other = await api('/repos', owner, { body: { name: 'not-mine', workspace: 'someone_else' } });
  expect([other.status, other.body.error.code]).toEqual([403, 'FORBIDDEN']);
  const recipient = { cookie: await signup('provisioned_owner') };
  const operator = { token: 'local-test-owner' };
  const provisioned = await api('/repos', operator, {
    body: { name: 'for-reviewer', workspace: 'provisioned_owner', files: [file('README.md', 'y\n')], author, tokens: [{ name: 'agents', scopes: ['read'] }] },
  });
  expect(provisioned.status).toBe(200);
  // The named workspace owns it: its own session reads and lists it; the creator's cannot,
  // and a private repository does not admit it exists to a non-member (404, not 403).
  expect((await api(`/repos/${provisioned.body.id}`, recipient)).status).toBe(200);
  expect((await api('/repos', recipient)).body.repos.map((r: any) => r.id)).toContain(provisioned.body.id);
  expect((await api(`/repos/${provisioned.body.id}`, owner)).status).toBe(404);
});
