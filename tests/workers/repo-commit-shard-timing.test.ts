// Where a commit's `shard.record` time goes (B4/C2). The hosted many-repo burst showed a
// ~55 ms median but a 0.5-1.1 s tail; these tests pin the sub-phases each commit reports
// so a hosted run can attribute that tail, and the record's durability once answered.
// Local workerd is single-threaded: the timings here are relative only.
import { evictDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { withWaitUntil } from '../../cloudflare/worker/background';
import { projectObjects } from '../../cloudflare/worker/repo-projection';
import { shardCall, shardOf } from '../../cloudflare/worker/repo-shards';
import { api, author, bindings, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const phasesOf = (header: string) =>
  Object.fromEntries(
    header
      .split(',')
      .filter(Boolean)
      .map((part) => {
        const [name, dur, desc] = part.trim().split(';');
        return [name, { ms: Number(dur.slice(4)), n: Number(desc?.match(/\d+/)?.[0] ?? 1) }];
      }),
  ) as Record<string, { ms: number; n: number }>;

async function burstRepo(name: string) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: { name, policy: { required_checks: [], approvals: 0 }, files: [file('README.md', '# burst\n')], author } });
  expect(created.status).toBe(200);
  const repo = `/repos/${created.body.id}`;
  const minted = await api(`${repo}/tokens`, owner, { body: { name: 'burst', scopes: ['read', 'write', 'land'] } });
  return { repo, token: minted.body.token as string, id: created.body.id as string };
}

async function commitOn(repo: string, token: string, path: string) {
  const made = await api(`${repo}/commits`, { token }, { body: { ref: 'main', changes: [file(path, `${path}\n`)], message: path, author } });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return { ...made, phases: phasesOf(made.headers.get('server-timing') ?? '') };
}

const shardStub = (id: string, commit: string) =>
  bindings.COMMIT_SHARDS.get(bindings.COMMIT_SHARDS.idFromName(`${id}:${shardOf(commit)}`));

async function storedRecord(id: string, commit: string) {
  const response = await shardStub(id, commit).fetch('https://commit-shard/', {
    method: 'POST',
    body: JSON.stringify({ op: 'store_commit', commit, _system: 'commits' }),
  });
  return response.json<any>();
}

const SUB_PHASES = ['shard.prep', 'shard.in', 'shard.body', 'shard.sql', 'shard.sync', 'shard.out'];

it('reports where each record spends its time', async () => {
  const { repo, token } = await burstRepo('shardphases');
  const made = await commitOn(repo, token, 'w/0.txt');
  for (const phase of ['shard.record', ...SUB_PHASES]) expect(made.phases[phase], phase).toBeDefined();
  // The shard's own split and the two legs between the clocks add up to the round trip;
  // only `in` and `out` compare two machines' clocks, so only their split carries skew.
  const p = made.phases;
  const parts = p['shard.in'].ms + p['shard.body'].ms + p['shard.sql'].ms + p['shard.sync'].ms + p['shard.out'].ms;
  expect(Math.abs(parts - p['shard.record'].ms)).toBeLessThan(3);
  // Created with the repository, the shard is warm and served nothing else at once.
  expect(p['shard.fresh']).toBeUndefined();
  expect(p['shard.inflight']).toBeUndefined();
});

it('flags a record served by a shard instance that just started', async () => {
  const { repo, token, id } = await burstRepo('shardfresh');
  const first = await commitOn(repo, token, 'w/0.txt');
  // A later commit on the same shard after its instance was evicted starts it again.
  await evictDurableObject(shardStub(id, first.body.commit));
  let fresh: Awaited<ReturnType<typeof commitOn>> | undefined;
  for (let i = 1; i < 400 && !fresh; i++) {
    const next = await commitOn(repo, token, `w/${i}.txt`);
    if (shardOf(next.body.commit) === shardOf(first.body.commit)) fresh = next;
    else expect(next.phases['shard.fresh']).toBeUndefined();
  }
  expect(fresh?.phases['shard.fresh']?.n).toBe(1);
  console.log(JSON.stringify({ measured: 'record on a restarted shard instance (local workerd)', record_ms: fresh?.phases['shard.record'].ms, in_ms: fresh?.phases['shard.in'].ms }));
});

it('keeps an answered record durable and readable from a restarted shard', async () => {
  const { repo, token, id } = await burstRepo('sharddurable');
  const made = await commitOn(repo, token, 'w/0.txt');
  // Read after commit, from another stub; then after the instance is torn down.
  expect((await storedRecord(id, made.body.commit)).commit.id).toBe(made.body.commit);
  await evictDurableObject(shardStub(id, made.body.commit));
  const after = await storedRecord(id, made.body.commit);
  expect(after.commit).toMatchObject({ id: made.body.commit, tree: made.body.tree });
  expect(after.objects.length).toBeGreaterThan(0);
  // And any request reads it back by id at once.
  const shown = await api(`${repo}/commits/${made.body.commit}`, { token });
  expect(shown.body).toMatchObject({ commit: made.body.commit });
});

it('answers a retried record and a duplicate drain without a second effect', async () => {
  const { repo, token, id } = await burstRepo('shardretry');
  const made = await commitOn(repo, token, 'w/0.txt');
  const shard = shardOf(made.body.commit);
  // A record retried after a reset finds the commit recorded and asks for no second drain.
  const again = await shardCall(scoped, id, shard, { op: 'store_record', commit: made.body.commit, timing: true });
  expect(again).toMatchObject({ already: true, dispatch_objects: false });
  // The drain request is delivered at least once: twice here, and the second finds nothing.
  const job = `shard:${shard}`;
  expect(queued.filter((m) => m.kind === 'platform_objects' && m.job_id === job)).toHaveLength(1);
  expect(await projectObjects(scoped, id, job)).toMatchObject({ projected: 1 });
  expect(await projectObjects(scoped, id, job)).toMatchObject({ projected: 0, more: false });
  expect(await bindings.OBJECTS.head(`platform/v1/${id}/git/${made.body.commit}`)).not.toBeNull();
  expect((await storedRecord(id, made.body.commit)).commit.id).toBe(made.body.commit);
});

const pct = (values: number[], q: number) =>
  Math.round([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))] * 10) / 10;

it('measures the record sub-phases in the many-repo burst shape', async () => {
  const made = await Promise.all(Array.from({ length: 4 }, (_, r) => burstRepo(`shardburst${r}`)));
  const burst = await Promise.all(
    made.flatMap(({ repo, token }) => Array.from({ length: 10 }, (_, i) => commitOn(repo, token, `w/${i}.txt`))),
  );
  const names = [...new Set(burst.flatMap((c) => Object.keys(c.phases)))];
  const summary = Object.fromEntries(
    names.map((name) => {
      const values = burst.map((c) => c.phases[name]?.ms).filter((v): v is number => v !== undefined);
      return [name, `${pct(values, 0.5)}/${pct(values, 0.95)} (${values.length})`];
    }),
  );
  console.log(JSON.stringify({ measured: 'commit phases p50/p95 (samples), 4 repos x 10 writers, local workerd', ...summary }));
});

it('answers a commit without waiting for the edge cache', async () => {
  const { repo, token } = await burstRepo('edgeslow');
  // A Cache API put that takes seconds (seen hosted on 2026-10-28: commit p95 18.7 s, all of
  // it in `cache.edge`) must not hold the answer: the edge copy is written after it, on the
  // waitUntil the entrypoint lends (lent here as the entrypoint does).
  const slow = vi
    .spyOn(caches.default, 'put')
    .mockImplementation(() => new Promise((done) => setTimeout(done, 3_000)));
  const after: Promise<unknown>[] = [];
  try {
    const started = Date.now();
    const made = await withWaitUntil(
      (work) => after.push(work),
      () => commitOn(repo, token, 'w/edge.txt'),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(made.phases['cache.edge']).toBeUndefined();
    expect(after.length).toBeGreaterThan(0);
    // The commit reads back at once, from the tiers behind the edge.
    const read = await api(`${repo}/blob?path=w/edge.txt&commit=${made.body.commit}`, { token });
    expect(read.status).toBe(200);
  } finally {
    await Promise.all(after);
    slow.mockRestore();
  }
});
