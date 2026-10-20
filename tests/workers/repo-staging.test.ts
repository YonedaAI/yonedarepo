// Staged commits: accepted once the authority holds their objects, then written to R2 (the
// store of record) by the projector; protected refs carry them on to Artifacts. An outage
// of either store after acceptance loses nothing: the commit stays readable, the outbox
// stays visible, refs wait without drift, and a later (or repeated) projection settles it.
import { expect, it } from 'vitest';
import { projectObjects, projectRefs } from '../../cloudflare/worker/repo-projection';
import type { Env } from '../../cloudflare/worker/types';
import {
  api,
  artifacts,
  author,
  bindings,
  file,
  misses,
  pushes,
  queued,
  receivePacks,
  scoped,
  signup,
  usePlatformFixture,
} from './repo-fixture';

usePlatformFixture();
const EDGE = 'https://objects.yoneda.internal';

async function repo(name: string) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: { name, policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } });
  await projectObjects(scoped, created.body.id);
  for (const message of queued.splice(0).filter((m) => m.kind === 'platform_project')) await projectRefs(scoped, message);
  return { owner, id: created.body.id as string, path: `/repos/${created.body.id}` };
}

/** R2 that refuses writes to the store of record while `down` is set. */
function flakyR2() {
  const state = { down: true };
  const r2 = new Proxy(bindings.OBJECTS, {
    get(target, prop) {
      if (prop === 'put')
        return (key: string, ...rest: unknown[]) => {
          if (state.down && key.includes('/git/')) return Promise.reject(new Error('R2 unavailable'));
          return (target.put as any)(key, ...rest);
        };
      const value = (target as any)[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...scoped, OBJECTS: r2 } as unknown as Env, state };
}

it('keeps an accepted commit readable and pending through store outages', async () => {
  const { owner, id, path } = await repo('outage');
  const made = await api(`${path}/commits`, owner, { body: { ref: 'main', changes: [file('dir/b.txt', 'b\n')], message: 'b', author } });
  expect(made.status).toBe(200);
  expect(made.body.staged).toBe(true);
  expect(queued.filter((m) => m.kind === 'platform_objects')).toHaveLength(1);

  // R2 refuses the writes: the outbox stays pending with the reason.
  const r2 = flakyR2();
  await expect(projectObjects(r2.env, id)).rejects.toThrow(/not in R2/);
  const status = (await api(path, owner)).body;
  expect(status.objects.pending).toBe(1);
  expect(status.objects.oldest).toMatchObject({ commit_id: made.body.commit, attempts: 1 });
  expect(status.objects.oldest.detail).toContain('R2 unavailable');

  // Without cached copies, reads fall through R2 and the store to the staged copy.
  const tree = (await api(`${path}/commits/${made.body.commit}`, owner)).body.tree;
  const listed = (await api(`${path}/tree?commit=${made.body.commit}&path=dir`, owner)).body;
  for (const object of [tree, ...listed.entries.map((e: any) => e.id)]) {
    await caches.default.delete(new Request(`${EDGE}/${id}/${object}`));
    await bindings.OBJECTS.delete(`platform/v1/${id}/objects/${object}`);
  }
  misses.length = 0;
  const read = await api(`${path}/blob?commit=${made.body.commit}&path=dir/b.txt`, owner);
  expect(read.body.content).toBe('b\n');
  expect(misses.length).toBeGreaterThan(0); // Artifacts did not have them

  // Artifacts is down too: main lands, its projection fails and retries; never drift.
  receivePacks.down = true;
  expect((await api(`${path}/land`, owner, { body: { ref: 'main', commit: made.body.commit } })).body.landed).toBe(true);
  const project = queued.splice(0).find((m) => m.kind === 'platform_project');
  await expect(projectRefs(scoped, project)).rejects.toThrow();
  expect((await api(path, owner)).body.projections[0].status).toBe('pending');

  // Artifacts recovers first: the ref goes out with objects read from the staged copy.
  receivePacks.down = false;
  await projectRefs(scoped, project);
  expect(pushes.at(-1)).toMatch(new RegExp(`${made.body.commit} refs/heads/main$`));
  expect(artifacts.get(`yr-${id}`)?.get(made.body.commit)?.kind).toBe('commit');
  // Then R2: the outbox drains into the store of record.
  r2.state.down = false;
  await projectObjects(r2.env, id);
  const settled = (await api(path, owner)).body;
  expect(settled.objects.pending).toBe(0);
  expect(settled.projections[0]).toMatchObject({ status: 'ok', projected_commit: made.body.commit });
  expect(await bindings.OBJECTS.head(`platform/v1/${id}/git/${made.body.commit}`)).not.toBeNull();
});

it('settles duplicate and concurrent projections exactly once', async () => {
  const { owner, id, path } = await repo('duplicates');
  const made = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      api(`${path}/commits`, owner, { body: { ref: 'main', changes: [file(`f/${i}.txt`, `${i}\n`)], message: `c${i}`, author } }),
    ),
  );
  expect(made.every((m) => m.body.staged)).toBe(true);
  // Redelivered messages run side by side; every commit still ends in R2, settled once.
  await Promise.all([projectObjects(scoped, id), projectObjects(scoped, id), projectObjects(scoped, id)]);
  await projectObjects(scoped, id);
  for (const m of made) expect(await bindings.OBJECTS.head(`platform/v1/${id}/git/${m.body.commit}`)).not.toBeNull();
  expect((await api(path, owner)).body.objects.pending).toBe(0);
});
