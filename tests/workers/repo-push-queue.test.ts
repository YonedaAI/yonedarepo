// Artifacts takes one receive-pack per repository at a time; concurrent commits share
// combined pushes through the repository's push queue, and a busy store is waited out.
import { expect, it, vi } from 'vitest';
import { PushBatcher } from '../../cloudflare/worker/repo-push-queue';
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

it('combines commits queued behind a push in flight into one receive-pack, one hidden ref each', async () => {
  const owner = { cookie: await signup('pushqueue') };
  const path = await repo(owner);
  const before = receivePacks.requests;
  // Whether concurrent commits overlap at the queue depends on scheduling, so the test makes
  // the overlap certain: the first receive-pack is held until all six pushes reached the queue.
  let release = () => {};
  receivePacks.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let submitted = 0;
  let allSubmitted = () => {};
  const queuedAll = new Promise<void>((resolve) => {
    allSubmitted = resolve;
  });
  const push = PushBatcher.prototype.push;
  vi.spyOn(PushBatcher.prototype, 'push').mockImplementation(function (this: PushBatcher, ...args) {
    const pushed = push.apply(this, args);
    if (++submitted === 6) allSubmitted();
    return pushed;
  });
  const commits = Array.from({ length: 6 }, (_, i) =>
    api(`${path}/commits`, owner, { body: { ref: 'main', changes: bulk(`f${i}`), message: `c${i}`, author } }),
  );
  try {
    // A commit answering first never pushed (it would wait on the held one): fail, not hang.
    const early = await Promise.race([queuedAll.then(() => null), Promise.race(commits)]);
    expect(early, 'a commit answered before all six pushes reached the queue').toBeNull();
    // One receive-pack is in flight; the other five pushes wait behind it.
    expect(receivePacks.requests - before).toBe(1);
  } finally {
    release();
  }
  const made = await Promise.all(commits);
  expect(made.map((m) => m.status)).toEqual(Array(6).fill(200));
  expect(receivePacks.requests - before).toBe(2);
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
