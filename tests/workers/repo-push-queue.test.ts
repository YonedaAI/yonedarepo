// Artifacts takes one receive-pack per repository at a time; concurrent commits share
// combined pushes through the repository's push queue, and a busy store is waited out.
import { expect, it } from 'vitest';
import { api, author, drainObjects, file, pushes, receivePacks, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

async function repo(owner: { cookie: string }) {
  const created = await api('/repos', owner, {
    body: { name: `push${Date.now()}`, policy: { required_checks: [], approvals: 0 }, files: [file('README.md', '# r\n')], author },
  });
  expect(created.status).toBe(200);
  await drainObjects();
  return `/repos/${created.body.id}`;
}

// Commits too large to stage (bulk imports) are pushed before they are accepted.
const bulk = (tag: string) => Array.from({ length: 300 }, (_, k) => file(`${tag}/${k}.txt`, `${tag} ${k}\n`));

it('combines concurrent commits into fewer receive-packs, one hidden ref each', async () => {
  const owner = { cookie: await signup('pushqueue') };
  const path = await repo(owner);
  const before = receivePacks.requests;
  const made = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      api(`${path}/commits`, owner, { body: { ref: 'main', changes: bulk(`f${i}`), message: `c${i}`, author } }),
    ),
  );
  expect(made.map((m) => m.status)).toEqual(Array(6).fill(200));
  expect(receivePacks.requests - before).toBeLessThan(6);
  for (const m of made) expect(pushes).toContain(`${'0'.repeat(40)} ${m.body.commit} refs/yoneda/c/${m.body.commit}`);
});

it('waits out a busy object store instead of failing the commit', async () => {
  const owner = { cookie: await signup('pushbusy') };
  const path = await repo(owner);
  receivePacks.busy = 2;
  const before = receivePacks.requests;
  const made = await api(`${path}/commits`, owner, { body: { ref: 'main', changes: bulk('b'), message: 'b', author } });
  expect(made.status).toBe(200);
  expect(receivePacks.requests - before).toBe(3);
  expect(receivePacks.busy).toBe(0);
});
