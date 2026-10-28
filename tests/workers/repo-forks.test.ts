// Forks through the real authorities (workerd, R2 stores): a reader of a repository forks
// it (owning the fork), reads and commits on the fork with inherited history served from the
// parent's store, opens a change on the parent from a fork branch (its objects copied into
// the parent first), and the parent's owner lands it. Inherited objects named by id, or
// omitted by a push, need read on the parent. A parent with forks is deleted only after them.
import { expect, it } from 'vitest';
import { compute } from '../../cloudflare/worker/repo-compute';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, drainObjects, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2', ARTIFACTS: undefined } as unknown as Env;
const text = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const raw = (hexId: string) => Uint8Array.from(hexId.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
type Raw = { id: string; kind: 'commit' | 'tree' | 'blob'; data: Uint8Array };

async function object(kind: Raw['kind'], data: Uint8Array): Promise<Raw> {
  const whole = new Uint8Array([...text.encode(`${kind} ${data.length}\0`), ...data]);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', whole))), kind, data };
}

/** A stock-Git push of `objects` (the commit first) creating `refname`, as `password`. */
async function push(repo: string, password: string, refname: string, objects: Raw[]) {
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
      headers: { authorization: `Basic ${btoa(`git:${password}`)}` },
      body: Uint8Array.from(atob(push_b64), (c) => c.charCodeAt(0)),
    }),
    local,
  );
  return `${response.status} ${new TextDecoder().decode(await response.arrayBuffer())}`;
}

it('forks, commits on the fork, and lands a change from it on the parent', async () => {
  const alice = { cookie: await signup('fork_alice') };
  const bob = { cookie: await signup('fork_bob') };
  const carol = { cookie: await signup('fork_carol') };
  const created = await api('/repos', alice, { body: { name: 'upstream', policy: { approvals: 1, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, local);
  const parent = created.body.id as string;
  await drainObjects(local);
  expect((await api(`/repos/${parent}/members`, alice, { body: { account: 'fork_bob', role: 'read' } }, local)).status).toBe(200);

  // Read on the parent is enough to fork; no read, no fork.
  expect((await api(`/repos/${parent}/fork`, carol, { body: {} }, local)).status).toBe(404);
  const forked = await api(`/repos/${parent}/fork`, bob, { body: { name: 'mine' } }, local);
  expect(forked.status, JSON.stringify(forked.body)).toBe(200);
  expect(forked.body).toMatchObject({ name: 'mine', parent, refs: 1, commits: 1 });
  const fork = forked.body.id as string;
  expect((await api('/repos', bob, {}, local)).body.repos.map((r: any) => r.id)).toContain(fork);
  expect((await api(`/repos/${fork}`, bob, {}, local)).body.parent).toEqual({ repo: parent, version: 1 });
  expect((await api(`/repos/${fork}/refs`, bob, {}, local)).body.refs['refs/heads/main']).toBe(created.body.commit);
  // Inherited history reads through the parent's store; nothing was copied.
  expect((await api(`/repos/${fork}/blob?path=a.md`, bob, {}, local)).body.content).toBe('a\n');
  expect((await bindings.OBJECTS.list({ prefix: `platform/v1/${fork}/git/` })).objects).toEqual([]);

  // A commit on the fork builds on the inherited tree, then becomes a branch.
  const committed = await api(`/repos/${fork}/commits`, bob, { body: { parent: created.body.commit, changes: [file('src/fork.ts', 'forked\n')], message: 'From the fork', author } }, local);
  expect(committed.status, JSON.stringify(committed.body)).toBe(200);
  const head = committed.body.commit as string;
  expect((await api(`/repos/${fork}/refs/batch`, bob, { body: { updates: [{ ref: 'feature', commit: head, expected: null }] } }, local)).status).toBe(200);
  await drainObjects(local);

  // The change: opened on the parent by the fork's writer, who only reads the parent.
  expect((await api(`/repos/${parent}/changes`, carol, { body: { fork, branch: 'feature', title: 'x' } }, local)).status).toBe(404);
  expect((await api(`/repos/${parent}/changes`, alice, { body: { fork, branch: 'feature', title: 'x' } }, local)).status).toBe(404);
  const opened = await api(`/repos/${parent}/changes`, bob, { body: { fork, branch: 'feature', title: 'Fork work' } }, local);
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  expect(opened.body).toMatchObject({ branch: `forks/${fork}/feature`, head, source_repo: fork, source_branch: 'feature', author: 'user:fork_bob' });
  const blob = await object('blob', text.encode('forked\n'));
  expect(await bindings.OBJECTS.head(`platform/v1/${parent}/git/${blob.id}`)).not.toBeNull();
  const shown = await api(`/repos/${parent}/changes/${opened.body.number}`, alice, {}, local);
  expect(shown.body.diff.changes.map((c: any) => c.path)).toEqual(['src/fork.ts']);

  // The parent's owner approves and lands it with the usual rules.
  expect((await api(`/repos/${parent}/commits/${head}/reviews`, alice, { body: { decision: 'approve' } }, local)).status).toBe(200);
  const landed = await api(`/repos/${parent}/land`, alice, { body: { ref: 'main', commit: head } }, local);
  expect(landed.status, JSON.stringify(landed.body)).toBe(200);
  expect((await api(`/repos/${parent}/changes/${opened.body.number}`, alice, {}, local)).body.status).toBe('landed');
  expect((await api(`/repos/${parent}/blob?path=src/fork.ts`, alice, {}, local)).body.content).toBe('forked\n');

  // A parent with a fork is deleted only after the fork.
  expect((await api(`/repos/${parent}?confirm=upstream`, alice, { method: 'DELETE' }, local)).status).toBe(409);
  expect((await api(`/repos/${fork}?confirm=mine`, bob, { method: 'DELETE' }, local)).status).toBe(200);
  expect((await api(`/repos/${parent}?confirm=upstream`, alice, { method: 'DELETE' }, local)).status).toBe(200);
});

it('serves inherited objects named by id, or omitted by a push, only to readers of the parent', async () => {
  const alice = { cookie: await signup('guard_alice') };
  const bob = { cookie: await signup('guard_bob') };
  const created = await api('/repos', alice, { body: { name: 'guarded', files: [file('a.md', 'a\n')], author } }, local);
  const parent = created.body.id as string;
  await drainObjects(local);
  await api(`/repos/${parent}/members`, alice, { body: { account: 'guard_bob', role: 'read' } }, local);
  const fork = (await api(`/repos/${parent}/fork`, bob, { body: {} }, local)).body.id as string;
  const token = (await api(`/repos/${fork}/tokens`, bob, { body: { name: 'ci', scopes: ['read', 'write'] } }, local)).body.token as string;
  const inherited = await object('blob', text.encode('a\n'));
  const wanted = { objects: [{ id: inherited.id, kind: 'blob' }] };

  // By id: the fork's token holds no read on the parent; bob does.
  const refused = await api(`/repos/${fork}/objects`, { token }, { body: wanted }, local);
  expect([refused.status, refused.body.error?.code]).toEqual([403, 'FORBIDDEN']);
  expect(refused.body.error.message).toContain('need read on its parent');
  expect((await api(`/repos/${fork}/objects`, bob, { body: wanted }, local)).status).toBe(200);
  // By path from the fork's refs: reachable, so the token reads it.
  expect((await api(`/repos/${fork}/blob?path=a.md`, { token }, {}, local)).body.content).toBe('a\n');

  // A push omitting the inherited blob: refused for the token, accepted for bob's PAT.
  const added = await object('blob', text.encode('new\n'));
  const tree = await object('tree', new Uint8Array([...text.encode('100644 a.md\0'), ...raw(inherited.id), ...text.encode('100644 b.md\0'), ...raw(added.id)]));
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = await object('commit', text.encode(`tree ${tree.id}\nparent ${created.body.commit}\nauthor ${who}\ncommitter ${who}\n\nb\n`));
  const pack = [commit, tree, added];
  expect(await push(fork, token, 'refs/heads/b', pack)).toContain('need read on its parent');
  expect((await api(`/repos/${fork}/refs`, bob, {}, local)).body.refs['refs/heads/b']).toBeUndefined();
  const pat = (await api('/tokens', bob, { body: { name: 'git', scopes: ['repo:read', 'repo:write'] } })).body.token as string;
  expect(await push(fork, pat, 'refs/heads/b', pack)).toContain('ok refs/heads/b');
});

it('forks an org repository read through a team, and forks into an org only as its owner', async () => {
  const alice = { cookie: await signup('forkorg_alice') };
  const bob = { cookie: await signup('forkorg_bob') };
  await api('/orgs', alice, { body: { name: 'forkacme' } }, local);
  const created = await api('/repos', alice, { body: { name: 'app', owner: 'forkacme', files: [file('a.md', 'a\n')], author } }, local);
  const parent = created.body.id as string;
  await drainObjects(local);
  // bob reads the org's repository only through team "devs".
  await api('/orgs/forkacme/members', alice, { body: { account: 'forkorg_bob', role: 'member' } }, local);
  await api('/orgs/forkacme/teams', alice, { body: { name: 'devs' } }, local);
  expect((await api(`/repos/${parent}/fork`, bob, { body: {} }, local)).status).toBe(404);
  await api('/orgs/forkacme/teams/devs/members', alice, { body: { account: 'forkorg_bob' } }, local);
  expect((await api(`/repos/${parent}/members`, alice, { body: { account: 'team:forkacme/devs', role: 'read' } }, local)).status).toBe(200);
  const mine = await api(`/repos/${parent}/fork`, bob, { body: { name: 'bobs' } }, local);
  expect(mine.status, JSON.stringify(mine.body)).toBe(200);
  // The team's read reaches inherited objects named by id too (the guard asks the parent).
  const blob = await object('blob', text.encode('a\n'));
  expect((await api(`/repos/${mine.body.id}/objects`, bob, { body: { objects: [{ id: blob.id, kind: 'blob' }] } }, local)).status).toBe(200);
  // Into the org: its members may not, its owner may.
  expect((await api(`/repos/${parent}/fork`, bob, { body: { name: 'org-fork', owner: 'forkacme' } }, local)).status).toBe(403);
  const org = await api(`/repos/${parent}/fork`, alice, { body: { name: 'org-fork', owner: 'forkacme' } }, local);
  expect(org.status, JSON.stringify(org.body)).toBe(200);
  expect((await api('/orgs/forkacme/repos', alice, {}, local)).body.repos.map((r: any) => r.id)).toContain(org.body.id);
});
