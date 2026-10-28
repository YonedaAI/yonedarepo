// The commit path's tree reads (B4/C2): a commit on main rewrites the trees along its
// paths, so it needs the parent's trees. With no edge tier (the hosted Worker answers on
// workers.dev, where the Cache API stores nothing), each tree the Worker has not seen walks
// R2 (and, before the shard drains, the authority and every shard). These tests count the
// object reads each commit makes, by tier, in the many-repo burst's shape: local workerd,
// single-threaded, so the timings are relative only.
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isolateTrees } from '../../cloudflare/worker/repo-tree-memo';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, drainObjects, fakeCombiners, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

type Reads = { r2: string[]; authority: string[]; shards: string[] };
const request = new AsyncLocalStorage<Reads>();
const r2 = bindings.OBJECTS;
const authority = scoped.SOURCE_REPOS;
const shards = scoped.COMMIT_SHARDS as DurableObjectNamespace;
const kind = (key: string) => key.split('/')[3] ?? key;
/** Simulated round trips (ms), zero unless a test sets them: local storage answers at once. */
const latency = { get: 0, put: 0, durable: 0 };
const after = (ms: number) => (ms ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
const countingR2 = {
  get: async (key: string, ...rest: unknown[]) => {
    request.getStore()?.r2.push(`get:${kind(key)}`);
    await after(latency.get);
    return (r2.get as any)(key, ...rest);
  },
  put: async (key: string, ...rest: unknown[]) => {
    request.getStore()?.r2.push(`put:${kind(key)}`);
    await after(latency.put);
    return (r2.put as any)(key, ...rest);
  },
  head: (key: string) => r2.head(key),
  delete: (keys: any) => r2.delete(keys),
  list: (options: any) => r2.list(options),
};
const countingAuthority = {
  idFromName: (name: string) => authority.idFromName(name),
  get: (id: DurableObjectId) => {
    const stub = authority.get(id);
    return {
      fetch: async (url: string, init: RequestInit) => {
        request.getStore()?.authority.push(JSON.parse(String(init.body)).op);
        await after(latency.durable);
        return stub.fetch(url, init);
      },
    };
  },
};
const countingShards = {
  idFromName: (name: string) => shards.idFromName(name),
  get: (id: DurableObjectId) => {
    const stub = shards.get(id);
    return {
      fetch: async (url: string, init: RequestInit) => {
        request.getStore()?.shards.push(JSON.parse(String(init.body)).op);
        await after(latency.durable);
        return stub.fetch(url, init);
      },
    };
  },
};
/** The head holder's calls, each one round trip. */
const holders = scoped.LAND_COMBINERS as unknown as typeof fakeCombiners;
const slowHolders = {
  idFromName: (name: string) => name,
  get: (name: string) => {
    const real = holders.get(name) as Record<string, (...args: any[]) => Promise<any>>;
    const slow = (call: string) => async (...args: any[]) => {
      await after(latency.durable);
      return real[call](...args);
    };
    return { ...real, head: slow('head'), trees: slow('trees') };
  },
};

const swap = scoped as unknown as Record<string, unknown>;
beforeEach(() => {
  Object.assign(latency, { get: 0, put: 0, durable: 0 });
  Object.assign(swap, { OBJECTS: countingR2, SOURCE_REPOS: countingAuthority, COMMIT_SHARDS: countingShards, LAND_COMBINERS: slowHolders });
  // No edge tier, as on workers.dev: every match misses and puts store nothing.
  vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);
  vi.spyOn(caches.default, 'put').mockResolvedValue(undefined);
});
afterEach(() => {
  Object.assign(swap, { OBJECTS: r2, SOURCE_REPOS: authority, COMMIT_SHARDS: shards, LAND_COMBINERS: holders });
});

/** One commit on main with the tier reads and Server-Timing phases it caused. */
async function commitOn(repo: string, token: string, path: string) {
  const reads: Reads = { r2: [], authority: [], shards: [] };
  const value = await request.run(reads, () =>
    api(`${repo}/commits`, { token }, { body: { ref: 'main', changes: [file(path, `${path}\n`)], message: path, author } }),
  );
  expect(value.status, JSON.stringify(value.body)).toBe(200);
  const header = value.headers.get('server-timing') ?? '';
  const phase = (name: string) => Number(new RegExp(`(?:^|, )${name};dur=([\\d.]+)`).exec(header)?.[1] ?? 0);
  return { ...value, reads, trees: { ms: phase('trees') }, total: phase('total') };
}

async function burstRepo(name: string) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: { name, policy: { required_checks: [], approvals: 0 }, files: [file('README.md', '# burst\n')], author } });
  expect(created.status).toBe(200);
  const repo = `/repos/${created.body.id}`;
  const minted = await api(`${repo}/tokens`, owner, { body: { name: 'burst', scopes: ['read', 'write', 'land'] } });
  return { repo, token: minted.body.token as string, id: created.body.id as string };
}

/** Object reads across `made`: R2 reads (not each commit's write-through of its blobs),
 * authority calls and shard calls other than each commit's own record. */
/** Waits until the head holder loaded the head and warmed its trees (a warm head). */
const warmed = (id: string) => (fakeCombiners.get(`${id}#head`) as unknown as { idle(): Promise<void> }).idle();

const reads = (made: { reads: Reads }[]) => ({
  r2: made.flatMap((m) => m.reads.r2).filter((op) => op.startsWith('get:')).length,
  authority: made.flatMap((m) => m.reads.authority).length,
  shards: made.flatMap((m) => m.reads.shards).filter((op) => op !== 'store_record').length,
});

it('reads no tree from R2 to commit beside a fresh repository\'s first commit', async () => {
  const { repo, token } = await burstRepo('treesfresh');
  // The many-repo burst: ten writers, each one new file under w/, at once, from isolates
  // that never saw this repository (the one that created it is elsewhere).
  isolateTrees.clear();
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => commitOn(repo, token, `w/${i}.txt`)));
  console.log(JSON.stringify({ measured: 'fresh burst tree reads (local workerd, no edge)', ...reads(burst), ops: burst.flatMap((c) => [...c.reads.r2, ...c.reads.authority]), trees_ms: burst.map((c) => Math.round(c.trees.ms)) }));
  expect(reads(burst)).toEqual({ r2: 0, authority: 0, shards: 0 });
});

it('reads no tree from R2 to commit on a landed head, after its objects drained', async () => {
  const { repo, token, id } = await burstRepo('treeslanded');
  const first = await commitOn(repo, token, 'w/0.txt');
  expect((await api(`${repo}/land`, { token }, { body: { ref: 'main', commit: first.body.commit } })).body.landed).toBe(true);
  await drainObjects();
  await warmed(id);
  isolateTrees.clear();
  const next = await Promise.all(Array.from({ length: 10 }, (_, i) => commitOn(repo, token, `w/${i + 1}.txt`)));
  console.log(JSON.stringify({ measured: 'landed-head burst tree reads (local workerd, no edge)', ...reads(next), ops: next.flatMap((c) => [...c.reads.r2, ...c.reads.authority]), trees_ms: next.map((c) => Math.round(c.trees.ms)) }));
  expect(reads(next)).toEqual({ r2: 0, authority: 0, shards: 0 });
});

const p = (values: number[], q: number) => Math.round([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))]);
const summary = (made: { trees: { ms: number }; total: number }[]) => ({
  trees_p50_p95: `${p(made.map((m) => m.trees.ms), 0.5)}/${p(made.map((m) => m.trees.ms), 0.95)}`,
  total_p50_p95: `${p(made.map((m) => m.total), 0.5)}/${p(made.map((m) => m.total), 0.95)}`,
});

it('measures the trees phase in the burst shape with simulated round trips', async () => {
  // Simulated, not measured: R2 get 30 ms, put 150 ms, Durable Object call 15 ms (the
  // hosted head.fetch p50 is ~17 ms, the read path's cache.r2 write ~200 ms).
  const fresh = await burstRepo('treestimed');
  Object.assign(latency, { get: 30, put: 150, durable: 15 });
  isolateTrees.clear();
  const first = await Promise.all(Array.from({ length: 10 }, (_, i) => commitOn(fresh.repo, fresh.token, `w/${i}.txt`)));
  const landed = await api(`${fresh.repo}/land`, { token: fresh.token }, { body: { ref: 'main', commit: first[0].body.commit } });
  expect(landed.body.landed).toBe(true);
  await drainObjects();
  await warmed(fresh.id);
  isolateTrees.clear();
  const next = await Promise.all(Array.from({ length: 10 }, (_, i) => commitOn(fresh.repo, fresh.token, `w/${i + 10}.txt`)));
  console.log(JSON.stringify({ measured: 'trees phase ms, simulated round trips (local workerd, single-threaded)', fresh: summary(first), landed: summary(next) }));
});
