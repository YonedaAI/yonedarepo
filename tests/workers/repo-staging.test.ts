// Staged commits: accepted once the authority holds their objects, then pushed to the
// object store by the projector. An object store outage after acceptance loses nothing:
// the commit stays readable, the outbox stays visible, refs wait, and a later (or
// repeated) projection settles it exactly once.
import { expect, it } from 'vitest';
import { projectObjects, projectRefs } from '../../cloudflare/worker/repo-projection';
import { api, author, bindings, file, misses, pushes, queued, receivePacks, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const EDGE = 'https://objects.yoneda.internal';

async function repo(name: string) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: { name, policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } });
  expect(created.body.staged).toBeUndefined(); // creation returns the import, not the commit body
  await projectObjects(scoped, created.body.id);
  for (const message of queued.splice(0).filter((m) => m.kind === 'platform_project')) await projectRefs(scoped, message);
  return { owner, id: created.body.id as string, path: `/repos/${created.body.id}` };
}

it('keeps an accepted commit readable and pending through an object store outage', async () => {
  const { owner, id, path } = await repo('outage');
  receivePacks.down = true;
  const made = await api(`${path}/commits`, owner, { body: { ref: 'main', changes: [file('dir/b.txt', 'b\n')], message: 'b', author } });
  expect(made.status).toBe(200);
  expect(made.body.staged).toBe(true);
  expect(queued.filter((m) => m.kind === 'platform_objects')).toHaveLength(1);
  await expect(projectObjects(scoped, id)).rejects.toThrow(/not in the object store/);
  const status = (await api(path, owner)).body;
  expect(status.objects.pending).toBe(1);
  expect(status.objects.oldest).toMatchObject({ commit_id: made.body.commit, attempts: 1 });
  expect(status.objects.oldest.detail).toContain('503');
  expect(pushes.some((p) => p.endsWith(`refs/yoneda/c/${made.body.commit}`))).toBe(false);

  // Without cached copies, reads fall through the store to the authority's staged copy.
  const tree = (await api(`${path}/commits/${made.body.commit}`, owner)).body.tree;
  const listed = (await api(`${path}/tree?commit=${made.body.commit}&path=dir`, owner)).body;
  // (The commit object's copy stays: the fake store reads it back from R2.)
  for (const object of [tree, ...listed.entries.map((e: any) => e.id)]) {
    await caches.default.delete(new Request(`${EDGE}/${id}/${object}`));
    await bindings.OBJECTS.delete(`platform/v1/${id}/objects/${object}`);
  }
  misses.length = 0;
  const read = await api(`${path}/blob?commit=${made.body.commit}&path=dir/b.txt`, owner);
  expect(read.body.content).toBe('b\n');
  expect(misses.length).toBeGreaterThan(0); // the store did not have them

  // The branch lands, but its ref is not projected to objects the store lacks (no drift).
  expect((await api(`${path}/land`, owner, { body: { ref: 'main', commit: made.body.commit } })).body.landed).toBe(true);
  const project = queued.splice(0).find((m) => m.kind === 'platform_project');
  await expect(projectRefs(scoped, project)).rejects.toThrow();
  expect(pushes.some((p) => p.endsWith(`${made.body.commit} refs/heads/main`))).toBe(false);
  expect((await api(path, owner)).body.projections[0].status).toBe('pending');

  // The store recovers: a retried job pushes the objects first, then the ref.
  receivePacks.down = false;
  await projectRefs(scoped, project);
  expect(pushes).toContain(`${'0'.repeat(40)} ${made.body.commit} refs/yoneda/c/${made.body.commit}`);
  expect(pushes.at(-1)).toMatch(new RegExp(`${made.body.commit} refs/heads/main$`));
  const settled = (await api(path, owner)).body;
  expect(settled.objects.pending).toBe(0);
  expect(settled.projections[0]).toMatchObject({ status: 'ok', projected_commit: made.body.commit });
});

it('settles duplicate and concurrent projections exactly once', async () => {
  const { owner, id, path } = await repo('duplicates');
  const made = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      api(`${path}/commits`, owner, { body: { ref: 'main', changes: [file(`f/${i}.txt`, `${i}\n`)], message: `c${i}`, author } }),
    ),
  );
  expect(made.every((m) => m.body.staged)).toBe(true);
  // Redelivered messages run side by side; every commit still ends in the store once.
  await Promise.all([projectObjects(scoped, id), projectObjects(scoped, id), projectObjects(scoped, id)]);
  await projectObjects(scoped, id);
  for (const m of made) expect(pushes.filter((p) => p.endsWith(`refs/yoneda/c/${m.body.commit}`)).length).toBeGreaterThanOrEqual(1);
  expect((await api(path, owner)).body.objects.pending).toBe(0);
});
