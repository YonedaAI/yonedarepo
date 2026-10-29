// Branch refs are projected into the object store with expected-old leases; refusals
// become visible drift instead of forced updates.
import { expect, it, vi } from 'vitest';
import { projectObjects, projectRefs } from '../../cloudflare/worker/repo-projection';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { compute } from '../../cloudflare/worker/repo-compute';
import { fromBase64, parseStore, RepoObjects, toBase64 } from '../../cloudflare/worker/repo-objects';
import type { Env } from '../../cloudflare/worker/types';
import { api, artifacts, author, bindings, file, pushes, queued, receivePacks, refusals, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const zero = '0'.repeat(40);

/** Lands one commit on main and returns main's Git head after it (the commit built for its
 * batch; reading it waits for that projection, which queues the ref projection). */
async function landNext(repo: string, owner: { cookie: string }, text: string, target: Env = scoped) {
  return landOnMain(repo, owner, [file('a.txt', text)], target);
}
async function landOnMain(repo: string, owner: { cookie: string }, changes: unknown[], target: Env = scoped) {
  const made = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes, message: 'change', author } }, target);
  expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: made.body.commit } }, target)).body.landed).toBe(true);
  return (await api(`${repo}/refs`, owner, {}, target)).body.refs['refs/heads/main'] as string;
}
const drain = async (target: Env) => {
  for (const message of queued.splice(0)) {
    if (message.kind === 'platform_objects') await projectObjects(target, message.repo_id);
    if (message.kind === 'platform_project') await projectRefs(target, message);
  }
};

it('retries a refused update before calling it drift (a racing projection refuses it too)', async () => {
  const owner = { cookie: await signup('racing') };
  const created = await api('/repos', owner, { body: { name: 'race', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } });
  const repo = `/repos/${created.body.id}`;
  await drain(scoped);
  refusals.add('refs/heads/main');
  const second = await landNext(repo, owner, '1\n');
  const jobs = queued.splice(0).filter((m) => m.kind === 'platform_project');
  expect(await projectRefs(scoped, jobs[0], 1)).toMatchObject({ projected: 0, retry: 5 });
  expect((await api(repo, owner)).body.projections[0].status).toBe('pending');
  // The ref became pushable (the racing projection reported): the retry lands it.
  refusals.clear();
  expect(await projectRefs(scoped, jobs[0], 2)).toEqual({ projected: 1 });
  expect((await api(repo, owner)).body.projections[0]).toMatchObject({ status: 'ok', projected_commit: second });
});

it('projects landed branches to Artifacts with leases and records drift', async () => {
  const owner = { cookie: await signup('projector') };
  const created = await api('/repos', owner, { body: { name: 'p', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } });
  const repo = `/repos/${created.body.id}`;
  await drain(scoped);
  const branchPushes = () => pushes.filter((p) => p.endsWith(' refs/heads/main'));
  expect(branchPushes()).toEqual([`${zero} ${created.body.commit} refs/heads/main`]);
  expect((await api(repo, owner)).body.projections[0]).toMatchObject({ status: 'ok', projected_commit: created.body.commit });

  const second = await landNext(repo, owner, '1\n');
  await drain(scoped);
  expect(branchPushes().at(-1)).toBe(`${created.body.commit} ${second} refs/heads/main`);

  refusals.add('refs/heads/main');
  await landNext(repo, owner, '2\n');
  await drain(scoped);
  const drifted = (await api(repo, owner)).body.projections[0];
  expect(drifted).toMatchObject({ status: 'drift', projected_commit: second });
  expect(drifted.detail).toContain('stale info');
  // Drifted refs are not pushed again until resolved.
  const count = pushes.length;
  await landNext(repo, owner, '3\n');
  await drain(scoped);
  expect(pushes.filter((p) => p.endsWith(' refs/heads/main')).length).toBe(branchPushes().length);
  expect(pushes.length).toBe(count); // staged commits get no hidden refs either
});

it('projects only protected refs, carrying every object Artifacts lacks in one push', async () => {
  const owner = { cookie: await signup('protector') };
  const created = await api('/repos', owner, { body: { name: 'q', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } });
  const repo = `/repos/${created.body.id}`;
  await drain(scoped);
  const name = `yr-${created.body.id}`;
  // Work on another branch stays in the authority.
  const side = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('s.txt', 's\n')], message: 's', author } });
  expect((await api(`${repo}/land`, owner, { body: { ref: 'side', commit: side.body.commit } })).body.landed).toBe(true);
  const before = pushes.length;
  await drain(scoped);
  expect(pushes.length).toBe(before);
  expect(artifacts.get(name)?.has(side.body.commit)).toBe(false);
  // Two landings on main, projected together: one receive-pack with both commits' objects.
  const one = await landNext(repo, owner, '1\n');
  const two = await landNext(repo, owner, '2\n');
  const packs = receivePacks.requests;
  await drain(scoped);
  expect(receivePacks.requests - packs).toBe(1);
  expect(pushes.slice(before)).toEqual([`${created.body.commit} ${two} refs/heads/main`]);
  for (const commit of [one, two]) expect(artifacts.get(name)?.get(commit)?.kind).toBe('commit');
  expect((await api(repo, owner)).body.projections.map((p: any) => p.refname)).toEqual(['refs/heads/main']);
});

it('keeps R2-store refs in step and detects tampering', async () => {
  const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
  const owner = { cookie: await signup('localprojector') };
  const created = await api('/repos', owner, { body: { name: 'l', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } }, local);
  const repo = `/repos/${created.body.id}`;
  const store = parseStore(local, `r2:yr-${created.body.id}`) as unknown as { readRef(r: string): Promise<string | null> };
  await drain(local);
  expect(await store.readRef('refs/heads/main')).toBe(created.body.commit);
  const next = await landNext(repo, owner, '1\n', local);
  await drain(local);
  expect(await store.readRef('refs/heads/main')).toBe(next);

  await bindings.OBJECTS.put(`store/v1/yr-${created.body.id}/refs/heads/main`, created.body.commit);
  await landNext(repo, owner, '2\n', local);
  await drain(local);
  expect((await api(repo, owner, {}, local)).body.projections[0].status).toBe('drift');
  expect(await store.readRef('refs/heads/main')).toBe(created.body.commit);
});

it('projects a long backlog in one receive-pack per chunk, never a refused push', async () => {
  const owner = { cookie: await signup('backlog') };
  const created = await api('/repos', owner, { body: { name: 'k', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } });
  const repo = `/repos/${created.body.id}`;
  await drain(scoped);
  const landedCommits: string[] = [];
  for (let i = 0; i < 12; i++) {
    const files = Array.from({ length: 40 }, (_, k) => file(`b${i}/${k}.txt`, `${i}.${k}\n`));
    landedCommits.push(await landOnMain(repo, owner, files));
  }
  const warn = vi.spyOn(console, 'warn');
  const packs = receivePacks.requests;
  await drain(scoped);
  expect(receivePacks.requests - packs).toBe(2); // the older chunk under hidden refs, then main
  expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('object store push attempt'))).toEqual([]);
  for (const commit of landedCommits) expect(artifacts.get(`yr-${created.body.id}`)?.get(commit)?.kind).toBe('commit');
  expect((await api(repo, owner)).body.projections[0]).toMatchObject({ status: 'ok', projected_commit: landedCommits.at(-1) });
});

type Raw = { id: string; kind: 'commit' | 'tree' | 'blob'; data: Uint8Array };
const text = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
async function object(kind: Raw['kind'], data: Uint8Array): Promise<Raw> {
  const whole = new Uint8Array([...text.encode(`${kind} ${data.length}\0`), ...data]);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', whole))), kind, data };
}
const tree = (entries: [string, string, string][]) =>
  object('tree', new Uint8Array(entries.flatMap(([mode, name, id]) => [...text.encode(`${mode} ${name}\0`), ...(id.match(/../g) ?? []).map((h) => Number.parseInt(h, 16))])));

it('projects one huge pushed commit in bounded packs: its files under carriers, then the commit', async () => {
  const on = { ...scoped, PUSH_BUNDLES: 'on' } as unknown as Env;
  const owner = { cookie: await signup('huge') };
  const created = await api('/repos', owner, { body: { name: 'h', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } }, on);
  const id = created.body.id as string;
  await drain(on);
  const { token } = (await api(`/repos/${id}/tokens`, owner, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, on)).body;
  const main = (await api(`/repos/${id}/refs`, owner, {}, on)).body.refs['refs/heads/main'] as string;
  // One commit of 1,500 distinct files across 30 directories.
  const blobs: Raw[] = [];
  const dirs: [string, string, string][] = [];
  for (let d = 0; d < 30; d++) {
    const entries: [string, string, string][] = [];
    for (let k = d * 50; k < d * 50 + 50; k++) {
      const blob = await object('blob', text.encode(`file ${k}: ${'x'.repeat(k % 97)} ${k * 7919}\n`));
      blobs.push(blob);
      entries.push(['100644', `${k}.txt`, blob.id]);
    }
    const t = await tree(entries.sort(([, a], [, b]) => (a < b ? -1 : 1)));
    blobs.push(t);
    dirs.push(['40000', `d${String(d).padStart(2, '0')}`, t.id]);
  }
  const root = await tree(dirs);
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = await object('commit', text.encode(`tree ${root.id}\nparent ${main}\nauthor ${who}\ncommitter ${who}\n\nhuge\n`));
  const { push_b64 } = compute({
    op: 'branch_push',
    refname: 'refs/heads/main',
    old: main,
    new: commit.id,
    objects: [commit, root, ...blobs].map((o) => ({ id: o.id, kind: o.kind, data_b64: toBase64(o.data) })),
  });
  const pushed = await platformFetch(
    new Request(`https://yoneda/git/${id}.git/git-receive-pack`, { method: 'POST', headers: { authorization: `Basic ${btoa(`git:${token}`)}` }, body: fromBase64(push_b64) }),
    on,
  );
  expect(new TextDecoder().decode(await pushed.arrayBuffer())).toContain('ok refs/heads/main');

  const before = pushes.length;
  const sizes: number[] = [];
  const push = vi.spyOn(RepoObjects.prototype, 'push');
  push.mockImplementation(async function (this: RepoObjects, body: Uint8Array) {
    sizes.push(body.length);
    return this.store.push(body);
  });
  try {
    await drain(on);
  } finally {
    push.mockRestore();
  }
  // No pack carries the whole commit: the largest is at most about a third of them all.
  const total = sizes.reduce((n, s) => n + s, 0);
  expect(sizes.length).toBeGreaterThanOrEqual(4);
  expect(Math.max(...sizes)).toBeLessThan(total / 3);
  const held = artifacts.get(`yr-${id}`);
  expect(held?.get(commit.id)?.kind).toBe('commit');
  for (const b of blobs) expect(held?.get(b.id)?.kind, b.id).toBe(b.kind);
  // Every carrier ref made is deleted once the commit holds its files.
  const made = pushes.slice(before).filter((p) => p.startsWith(`${zero} `)).map((p) => p.split(' ')[2]);
  const deleted = new Set(pushes.slice(before).filter((p) => p.split(' ')[1] === zero).map((p) => p.split(' ')[2]));
  expect(made.filter((r) => deleted.has(r))).toHaveLength(4);
  expect(made.filter((r) => !deleted.has(r))).toEqual([`refs/yoneda/c/${commit.id}`]);
  expect((await api(`/repos/${id}`, owner, {}, on)).body.projections[0]).toMatchObject({ status: 'ok', projected_commit: commit.id });
});
