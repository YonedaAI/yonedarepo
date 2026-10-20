// Branch refs are projected into the object store with expected-old leases; refusals
// become visible drift instead of forced updates.
import { expect, it, vi } from 'vitest';
import { projectObjects, projectRefs } from '../../cloudflare/worker/repo-projection';
import { parseStore } from '../../cloudflare/worker/repo-objects';
import type { Env } from '../../cloudflare/worker/types';
import { api, artifacts, author, bindings, file, pushes, queued, receivePacks, refusals, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const zero = '0'.repeat(40);

async function landNext(repo: string, owner: { cookie: string }, text: string, target: Env = scoped) {
  const made = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('a.txt', text)], message: text, author } }, target);
  expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: made.body.commit } }, target)).body.landed).toBe(true);
  return made.body.commit as string;
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
    const made = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: files, message: `b${i}`, author } });
    expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: made.body.commit } })).body.landed).toBe(true);
    landedCommits.push(made.body.commit);
  }
  const warn = vi.spyOn(console, 'warn');
  const packs = receivePacks.requests;
  await drain(scoped);
  expect(receivePacks.requests - packs).toBe(2); // the older chunk under hidden refs, then main
  expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('object store push attempt'))).toEqual([]);
  for (const commit of landedCommits) expect(artifacts.get(`yr-${created.body.id}`)?.get(commit)?.kind).toBe('commit');
  expect((await api(repo, owner)).body.projections[0]).toMatchObject({ status: 'ok', projected_commit: landedCommits.at(-1) });
});
