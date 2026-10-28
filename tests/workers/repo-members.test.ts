// Repository members end to end: a second account reads, pushes and lands by its role
// (REST, MCP and stock Git over HTTPS with its personal token), is refused above it, sees
// the shared repository in its listing, and loses access the moment it is removed.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { compute } from '../../cloudflare/worker/repo-compute';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const text = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
type Raw = { id: string; kind: 'commit' | 'tree' | 'blob'; data: Uint8Array };
async function object(kind: Raw['kind'], data: Uint8Array): Promise<Raw> {
  const header = text.encode(`${kind} ${data.length}\0`);
  const whole = new Uint8Array(header.length + data.length);
  whole.set(header);
  whole.set(data, header.length);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', whole))), kind, data };
}
/** A commit on `parent` with one file, as stock Git would push it. */
async function commitOf(parent: string, label: string) {
  const blob = await object('blob', text.encode(`${label}\n`));
  const id = Uint8Array.from(blob.id.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
  const tree = await object('tree', new Uint8Array([...text.encode('100644 member.txt\0'), ...id]));
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = await object('commit', text.encode(`tree ${tree.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\n${label}\n`));
  return [commit, tree, blob];
}
const basic = (token: string) => `Basic ${btoa(`git:${token}`)}`;
async function git(repo: string, token: string, path: string, body?: Uint8Array) {
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: basic(token) },
      body,
    }),
    scoped,
  );
  return { status: response.status, text: new TextDecoder().decode(await response.arrayBuffer()) };
}
async function push(repo: string, token: string, refname: string, objects: Raw[]) {
  const { push_b64 } = compute({
    op: 'branch_push',
    refname,
    old: null,
    new: objects[0].id,
    objects: objects.map((o) => ({ id: o.id, kind: o.kind, data_b64: btoa(String.fromCharCode(...o.data)) })),
  });
  return git(repo, token, 'git-receive-pack', Uint8Array.from(atob(push_b64), (c) => c.charCodeAt(0)));
}

it('shares a repository by role across REST, Git and listing, and revokes at once', async () => {
  const owner = { cookie: await signup('members_owner') };
  const bob = { cookie: await signup('members_bob') };
  const carol = { cookie: await signup('members_carol') };
  const created = await api('/repos', owner, {
    body: { name: 'shared', policy: { required_checks: [], approvals: 1 }, files: [file('README.md', '# shared\n')], author },
  });
  const id = created.body.id as string;
  const repo = `/repos/${id}`;
  const main = (await api(`${repo}/refs`, owner)).body.refs['refs/heads/main'] as string;
  const role = (account: string, r: string) => api(`${repo}/members`, owner, { body: { account, role: r } });

  // Strangers see nothing; unknown accounts can't be invited; members can't manage members.
  expect((await api(`${repo}/refs`, bob)).status).toBe(404);
  expect((await role('members_nobody', 'read')).body.error.code).toBe('NOT_FOUND');
  expect((await role('members_owner', 'read')).status).toBe(403);
  expect((await role('members_bob', 'read')).body).toMatchObject({ account: 'members_bob', role: 'read' });
  expect((await api(`${repo}/members`, bob, { body: { account: 'members_carol', role: 'read' } })).status).toBe(403);
  expect((await api(`${repo}/members`, owner)).body.members).toMatchObject([{ account: 'members_bob', role: 'read', added_by: 'user:members_owner' }]);

  // read: the listing shows the shared repository; reads pass, writes don't.
  const listed = (await api('/repos', bob)).body.repos;
  expect(listed).toEqual([expect.objectContaining({ id, name: 'shared', owner: 'members_owner', role: 'read' })]);
  expect((await api('/repos', carol)).body.repos).toEqual([]);
  expect((await api(`${repo}/blob?path=README.md`, bob)).body.content).toBe('# shared\n');
  const change = { ref: 'main', changes: [file('b.md', 'bob\n')], message: 'bob', author };
  expect((await api(`${repo}/commits`, bob, { body: change })).status).toBe(403);
  const pat = (await api('/tokens', bob, { body: { name: 'laptop', scopes: ['repo:read', 'repo:write', 'repo:land', 'repo:review'] } })).body.token as string;
  expect((await git(id, pat, 'info/refs?service=git-upload-pack')).text).toContain(`${main} refs/heads/main`);
  expect((await git(id, pat, 'info/refs?service=git-receive-pack')).status).toBe(403);

  // write: commits and pushes a branch over stock Git; can't review or land main.
  await role('members_bob', 'write');
  const committed = await api(`${repo}/commits`, bob, { body: change });
  expect(committed.status).toBe(200);
  expect((await git(id, pat, 'info/refs?service=git-receive-pack')).status).toBe(200);
  const pushed = await push(id, pat, 'refs/heads/bob', await commitOf(main, 'from git'));
  expect(pushed.text).toContain('ok refs/heads/bob');
  expect((await api(`${repo}/land`, bob, { body: { ref: 'main', commit: committed.body.commit } })).status).toBe(403);

  // land: the owner's commit needs another person's approval; bob gives it and lands it.
  const owners = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('c.md', 'owner\n')], message: 'owner', author } });
  expect((await api(`${repo}/commits/${owners.body.commit}/reviews`, bob, { body: { decision: 'approve' } })).status).toBe(403);
  await role('members_bob', 'land');
  // Bob can't approve his own commit, by session or token.
  for (const who of [bob, { token: pat }])
    expect((await api(`${repo}/commits/${committed.body.commit}/reviews`, who, { body: { decision: 'approve' } })).status).toBe(403);
  expect((await api(`${repo}/commits/${owners.body.commit}/reviews`, bob, { body: { decision: 'approve' } })).status).toBe(200);
  const landed = await api(`${repo}/land`, { token: pat }, { body: { ref: 'main', commit: owners.body.commit } });
  expect(landed.body).toMatchObject({ landed: true });

  // admin: manages other members, never admins, never deletes the repository.
  await role('members_bob', 'admin');
  expect((await api(`${repo}/members`, bob, { body: { account: 'members_carol', role: 'write' } })).status).toBe(200);
  expect((await api(`${repo}/members`, bob, { body: { account: 'members_carol', role: 'admin' } })).status).toBe(403);
  expect((await api(`${repo}?confirm=shared`, bob, { method: 'DELETE' })).status).toBe(403);
  expect((await api(`${repo}/members/members_carol`, bob, { method: 'DELETE' })).status).toBe(200);

  // Removal ends access at once: REST reads (served from the published head), Git, listing.
  expect((await api(`${repo}/tree?path=`, bob)).status).toBe(200);
  expect((await api(`${repo}/members/members_bob`, owner, { method: 'DELETE' })).body).toMatchObject({ removed: true });
  expect((await api(`${repo}/tree?path=`, bob)).status).toBe(404);
  expect((await api(`${repo}/blob?path=README.md`, { token: pat })).status).toBe(404);
  expect((await git(id, pat, 'info/refs?service=git-upload-pack')).status).toBe(404);
  expect((await api('/repos', bob)).body.repos).toEqual([]);
  expect((await api(`${repo}/members`, owner)).body.members).toEqual([]);
});

it('caps a member token by its own scopes and serves members over MCP', async () => {
  const owner = { cookie: await signup('mcp_owner') };
  const dana = { cookie: await signup('mcp_dana') };
  const id = (await api('/repos', owner, { body: { name: 'tools', files: [file('a.md', 'a\n')], author } })).body.id as string;
  const mcp = async (who: { cookie?: string; token?: string }, name: string, args: Record<string, unknown>) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (who.cookie) headers.cookie = who.cookie;
    if (who.token) headers.authorization = `Bearer ${who.token}`;
    const response = await platformFetch(
      new Request('https://yoneda/api/v1/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
      scoped,
    );
    return (await response.json<any>()).result;
  };
  expect((await mcp(owner, 'git_member_add', { repo: id, account: 'mcp_dana', role: 'land' })).structuredContent).toMatchObject({ role: 'land' });
  expect((await mcp(owner, 'git_member_list', { repo: 'tools' })).structuredContent.members).toHaveLength(1);
  // A read-only token of a land member reads by name, but can't write.
  const reader = (await api('/tokens', dana, { body: { name: 'ro', scopes: ['repo:read'] } })).body.token as string;
  const read = await mcp({ token: reader }, 'git_cat_file', { repo: 'tools', path: 'a.md' });
  expect(read.structuredContent.content).toBe('a\n');
  const main = (await api(`/repos/${id}/refs`, owner)).body.refs['refs/heads/main'];
  const write = await mcp({ token: reader }, 'git_branch', { repo: 'tools', ref: 'x', commit: main });
  expect(write.isError).toBe(true);
  expect(write.content[0].text).toContain('FORBIDDEN');
  expect((await mcp(dana, 'git_member_remove', { repo: id, account: 'mcp_dana' })).isError).toBe(true);
  expect((await mcp(owner, 'git_member_remove', { repo: id, account: 'mcp_dana' })).structuredContent).toMatchObject({ removed: true });
  expect((await mcp({ token: reader }, 'git_cat_file', { repo: id, path: 'a.md' })).isError).toBe(true);
});
