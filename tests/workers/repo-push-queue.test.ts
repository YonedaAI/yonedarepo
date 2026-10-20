// Artifacts takes one receive-pack per repository at a time; concurrent commits share
// combined pushes through the repository's push queue, and a busy store is waited out.
import { expect, it } from 'vitest';
import { api, author, file, pushes, receivePacks, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

async function repo(owner: { cookie: string }) {
  const created = await api('/repos', owner, {
    body: { name: `push${Date.now()}`, policy: { required_checks: [], approvals: 0 }, files: [file('README.md', '# r\n')], author },
  });
  expect(created.status).toBe(200);
  return `/repos/${created.body.id}`;
}

it('combines concurrent commits into fewer receive-packs, one hidden ref each', async () => {
  const owner = { cookie: await signup('pushqueue') };
  const path = await repo(owner);
  const before = receivePacks.requests;
  const made = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      api(`${path}/commits`, owner, { body: { ref: 'main', changes: [file(`f/${i}.txt`, `${i}\n`)], message: `c${i}`, author } }),
    ),
  );
  expect(made.map((m) => m.status)).toEqual(Array(12).fill(200));
  expect(receivePacks.requests - before).toBeLessThan(12);
  for (const m of made) expect(pushes).toContain(`${'0'.repeat(40)} ${m.body.commit} refs/yoneda/c/${m.body.commit}`);
});

it('waits out a busy object store instead of failing the commit', async () => {
  const owner = { cookie: await signup('pushbusy') };
  const path = await repo(owner);
  receivePacks.busy = 2;
  const before = receivePacks.requests;
  const made = await api(`${path}/commits`, owner, { body: { ref: 'main', changes: [file('b.txt', 'b\n')], message: 'b', author } });
  expect(made.status).toBe(200);
  expect(receivePacks.requests - before).toBe(3);
  expect(receivePacks.busy).toBe(0);
});
