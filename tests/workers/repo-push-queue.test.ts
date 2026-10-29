// Artifacts takes one receive-pack per repository at a time; concurrent commits share
// combined pushes through the repository's push queue, and a busy store is waited out.
import { expect, it, vi } from 'vitest';
import { compute } from '../../cloudflare/worker/repo-compute';
import { fromBase64, toBase64 } from '../../cloudflare/worker/repo-objects';
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

const blobData = (n: number) => new TextEncoder().encode(`carried ${n}\n`);
async function blobId(n: number) {
  const data = blobData(n);
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const digest = await crypto.subtle.digest('SHA-1', new Uint8Array([...head, ...data]));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

it('sends a push carrying several refs alone, never combined again', async () => {
  // A projection sends a backlog's commits (or its carriers' deletes) as one push of
  // several refs; combining that with other waiting pushes refused the whole batch.
  const carrier = async (n: number) =>
    compute({ op: 'carrier_push', objects: [{ id: await blobId(n), kind: 'blob', data_b64: toBase64(blobData(n)) }] });
  const bodies = await Promise.all([0, 1, 2, 3, 4].map(async (n) => carrier(n)));
  const several = fromBase64(compute({ op: 'push_combine', bodies_b64: [bodies[1].push_b64, bodies[2].push_b64] }).push_b64);
  const batcher = new PushBatcher();
  const remote = 'https://artifacts.test/several';
  let release = () => {};
  receivePacks.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = receivePacks.requests;
  const first = batcher.push(remote, 't', fromBase64(bodies[0].push_b64));
  const waiting = [several, fromBase64(bodies[3].push_b64), fromBase64(bodies[4].push_b64)].map((b) => batcher.push(remote, 't', b));
  release();
  const reports = (await Promise.all([first, ...waiting])).map((p) => new TextDecoder().decode(p.report));
  for (const n of [1, 2]) expect(reports[1]).toContain(`ok refs/yoneda/c/${bodies[n].commit}`);
  expect(reports[2]).toContain(`ok refs/yoneda/c/${bodies[3].commit}`);
  expect(reports[3]).toContain(`ok refs/yoneda/c/${bodies[4].commit}`);
  // The held push, the several-ref push alone, then the two single ones together.
  expect(receivePacks.requests - before).toBe(3);
});
