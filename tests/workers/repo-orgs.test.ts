// Organizations end to end: an org with team "devs" owns a repository; a team member
// pushes over stock Git with an org-limited personal token, and leaving the team refuses
// them at once in the isolate that served the change and within ACCESS_MS everywhere else
// (an isolate's org access copy expires); org owners act as the repository owner.
import { expect, it, vi } from 'vitest';
import { ACCESS_MS } from '../../cloudflare/worker/repo-head';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { compute } from '../../cloudflare/worker/repo-compute';
import { workspace } from '../../cloudflare/worker/workspace';
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
async function commitOf(parent: string, label: string) {
  const blob = await object('blob', text.encode(`${label}\n`));
  const id = Uint8Array.from(blob.id.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
  const tree = await object('tree', new Uint8Array([...text.encode('100644 team.txt\0'), ...id]));
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = await object('commit', text.encode(`tree ${tree.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\n${label}\n`));
  return [commit, tree, blob];
}
async function push(repo: string, token: string, refname: string, objects: Raw[]) {
  const { push_b64 } = compute({
    op: 'branch_push',
    refname,
    old: null,
    new: objects[0].id,
    objects: objects.map((o) => ({ id: o.id, kind: o.kind, data_b64: btoa(String.fromCharCode(...o.data)) })),
  });
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/git-receive-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}` },
      body: Uint8Array.from(atob(push_b64), (c) => c.charCodeAt(0)),
    }),
    scoped,
  );
  return { status: response.status, text: new TextDecoder().decode(await response.arrayBuffer()) };
}

it('an org team member pushes and leaving the team refuses them within the access bound', async () => {
  const alice = { cookie: await signup('orgs_alice') };
  const bob = { cookie: await signup('orgs_bob') };
  expect((await api('/orgs', alice, { body: { name: 'acme' } })).body).toMatchObject({ org: 'acme', role: 'owner' });
  expect((await api('/orgs', bob, { body: { name: 'acme' } })).status).toBe(409);
  expect((await api('/orgs', bob, { body: { name: 'orgs_alice' } })).status).toBe(409);
  expect((await api('/orgs', alice)).body.orgs).toEqual([{ org: 'acme', role: 'owner' }]);
  expect((await api('/orgs/acme', bob)).status).toBe(403);

  // Only org owners create the org's repositories.
  const repoBody = { name: 'app', owner: 'acme', policy: { required_checks: [], approvals: 0 }, files: [file('README.md', '# app\n')], author };
  expect((await api('/repos', bob, { body: repoBody })).status).toBe(403);
  const id = (await api('/repos', alice, { body: repoBody })).body.id as string;
  const repo = `/repos/${id}`;
  const main = (await api(`${repo}/refs`, alice)).body.refs['refs/heads/main'] as string;

  // bob joins the org and team "devs"; membership alone grants nothing on the repository.
  expect((await api('/orgs/acme/members', alice, { body: { account: 'orgs_nobody', role: 'member' } })).status).toBe(404);
  expect((await api('/orgs/acme/members', alice, { body: { account: 'orgs_bob', role: 'member' } })).body).toMatchObject({ role: 'member' });
  expect((await api('/repos', bob, { body: repoBody })).status).toBe(403);
  expect((await api('/orgs/acme/teams', bob, { body: { name: 'devs' } })).status).toBe(403);
  await api('/orgs/acme/teams', alice, { body: { name: 'devs' } });
  await api('/orgs/acme/teams/devs/members', alice, { body: { account: 'orgs_bob' } });
  expect((await api('/orgs', bob)).body.orgs).toEqual([{ org: 'acme', role: 'member' }]);
  expect((await api(`${repo}/refs`, bob)).status).toBe(403);
  expect((await api('/orgs/acme/repos', bob)).body.repos).toEqual([]);

  // The repository grants the team write; only existing teams can be named.
  expect((await api(`${repo}/members`, alice, { body: { account: 'team:acme/ops', role: 'write' } })).status).toBe(404);
  expect((await api(`${repo}/members`, alice, { body: { account: 'team:acme/devs', role: 'write' } })).body).toMatchObject({ account: 'team:acme/devs' });
  expect((await api('/repos', bob)).body.repos).toEqual([expect.objectContaining({ id, owner: 'acme', role: 'write' })]);
  expect((await api('/orgs/acme/repos', bob)).body.repos).toEqual([expect.objectContaining({ id, owner: 'acme' })]);

  // An org-limited token pushes to the org's repository and nowhere else.
  const created = await api('/tokens', bob, { body: { name: 'acme-ci', scopes: ['repo:read', 'repo:write'], org: 'acme' } });
  expect(created.body.org).toBe('acme');
  const pat = created.body.token as string;
  expect((await push(id, pat, 'refs/heads/bob', await commitOf(main, 'bob 1'))).text).toContain('ok refs/heads/bob');
  const own = (await api('/repos', bob, { body: { name: 'mine', files: [file('a.md', 'a\n')], author } })).body.id as string;
  expect((await api(`/repos/${own}/refs`, { token: pat })).status).toBe(403);
  expect((await api('/repos', { token: pat })).body.repos.map((r: any) => r.id)).toEqual([id]);

  // Leaving the team: refused at once by the isolate that served the change.
  expect((await api('/orgs/acme/teams/devs/members/orgs_bob', alice, { method: 'DELETE' })).body).toMatchObject({ removed: true });
  expect((await push(id, pat, 'refs/heads/bob2', await commitOf(main, 'bob 2'))).status).toBe(403);
  expect((await api(`${repo}/tree?path=`, bob)).status).toBe(403);

  // Another isolate (a change it did not serve) decides on its copy for under ACCESS_MS,
  // then asks the org again.
  await api('/orgs/acme/teams/devs/members', alice, { body: { account: 'orgs_bob' } });
  expect((await api(`${repo}/tree?path=`, bob)).status).toBe(200);
  await workspace(scoped, 'acme', { op: 'team_member_remove', actor: 'orgs_alice', team: 'devs', account: 'orgs_bob', now: Date.now() });
  expect((await api(`${repo}/tree?path=`, bob)).status).toBe(200);
  const real = Date.now;
  vi.spyOn(Date, 'now').mockImplementation(() => real() + ACCESS_MS);
  expect((await api(`${repo}/tree?path=`, bob)).status).toBe(403);
  expect((await push(id, pat, 'refs/heads/bob3', await commitOf(main, 'bob 3'))).status).toBe(403);
  vi.restoreAllMocks();

  // Org owners act as the repository owner; leaving the org drops it from the listing.
  expect((await api(`${repo}/members`, alice, { body: { account: 'orgs_bob', role: 'admin' } })).status).toBe(200);
  await api(`${repo}/members/orgs_bob`, alice, { method: 'DELETE' });
  expect((await api('/orgs/acme/members/orgs_alice', alice, { method: 'DELETE' })).status).toBe(403);
  expect((await api('/orgs/acme/members/orgs_bob', bob, { method: 'DELETE' })).body).toMatchObject({ removed: true });
  expect((await api('/orgs', bob)).body.orgs).toEqual([]);
  expect((await api(`${repo}?confirm=app`, alice, { method: 'DELETE' })).body).toMatchObject({ deleted: true });
});

it('serves organizations over the account MCP', async () => {
  const carol = { cookie: await signup('orgs_carol') };
  await signup('orgs_dave');
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const response = await platformFetch(
      new Request('https://yoneda/api/v1/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: carol.cookie },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
      scoped,
    );
    return (await response.json<any>()).result;
  };
  expect((await mcp('org_create', { name: 'beta' })).structuredContent).toMatchObject({ org: 'beta' });
  await mcp('org_member_add', { org: 'beta', account: 'orgs_dave', role: 'member' });
  await mcp('org_team_create', { org: 'beta', team: 'ops' });
  await mcp('org_team_member_add', { org: 'beta', team: 'ops', account: 'orgs_dave' });
  const shown = (await mcp('org_show', { org: 'beta' })).structuredContent;
  expect(shown.teams).toEqual([expect.objectContaining({ name: 'ops', members: ['orgs_dave'] })]);
  const repo = (await mcp('repo_create', { name: 'svc', owner: 'beta' })).structuredContent;
  expect((await mcp('org_repos', { org: 'beta' })).structuredContent.repos.map((r: any) => r.id)).toEqual([repo.id]);
  expect((await mcp('org_team_delete', { org: 'beta', team: 'ops' })).structuredContent).toMatchObject({ deleted: true });
  expect((await mcp('org_show', { org: 'nope_org' })).isError).toBe(true);

  // Deleting: refused while it owns repositories; the name is retired afterwards.
  const owning = await mcp('org_delete', { org: 'beta', confirm: 'beta' });
  expect(owning.content[0].text).toContain('CONFLICT');
  await mcp('repo_delete', { repo: repo.id, confirm: 'svc' });
  expect((await mcp('org_delete', { org: 'beta', confirm: 'bet' })).isError).toBe(true);
  expect((await mcp('org_delete', { org: 'beta', confirm: 'beta' })).structuredContent).toMatchObject({ deleted: true });
  expect((await mcp('org_list', {})).structuredContent.orgs).toEqual([]);
  expect((await mcp('org_show', { org: 'beta' })).isError).toBe(true);
  expect((await mcp('org_create', { name: 'beta' })).content[0].text).toContain('ALREADY_EXISTS');
});

it('a deleted team takes its grants with it: a new team of the same name starts with none', async () => {
  const erin = { cookie: await signup('orgs_erin') };
  const finn = { cookie: await signup('orgs_finn') };
  await api('/orgs', erin, { body: { name: 'gamma' } });
  await api('/orgs/gamma/members', erin, { body: { account: 'orgs_finn', role: 'member' } });
  await api('/orgs/gamma/teams', erin, { body: { name: 'devs' } });
  const id = (await api('/repos', erin, { body: { name: 'old', owner: 'gamma', files: [file('a.md', 'a\n')], author } })).body.id as string;
  await api(`/repos/${id}/members`, erin, { body: { account: 'team:gamma/devs', role: 'write' } });
  await api('/orgs/gamma/teams/devs', erin, { method: 'DELETE' });
  // Re-created under the same name, with finn in it: the old repository grant is not his.
  await api('/orgs/gamma/teams', erin, { body: { name: 'devs' } });
  await api('/orgs/gamma/teams/devs/members', erin, { body: { account: 'orgs_finn' } });
  expect((await api(`/repos/${id}/refs`, finn)).status).toBe(403);
  expect((await api('/repos', finn)).body.repos).toEqual([]);
  // Granting the new team works, and replaces the stale row; removing by name clears it.
  await api(`/repos/${id}/members`, erin, { body: { account: 'team:gamma/devs', role: 'read' } });
  expect((await api(`/repos/${id}/refs`, finn)).status).toBe(200);
  expect((await api(`/repos/${id}/members`, erin)).body.members).toEqual([expect.objectContaining({ account: 'team:gamma/devs', role: 'read' })]);
  expect((await api(`/repos/${id}/members/${encodeURIComponent('team:gamma/devs')}`, erin, { method: 'DELETE' })).body).toMatchObject({ removed: true });
  expect((await api(`/repos/${id}/refs`, finn)).status).toBe(403);
});
