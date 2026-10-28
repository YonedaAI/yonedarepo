// P5 / Scion S12: per-tier hit counts for the object path (seed -> Cache API -> R2 ->
// object store) and what a failing cache tier does to the origin. Measurements, labelled:
// local workerd with R2 standing in for the object store.
import { expect, it, vi } from 'vitest';
import { withWaitUntil } from '../../cloudflare/worker/background';
import { executeCheckRun } from '../../cloudflare/worker/repo-checks';
import { deriveAfterLanding } from '../../cloudflare/worker/repo-derived';
import { type ObjectStore, RepoObjects } from '../../cloudflare/worker/repo-objects';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
// Two read batches of 16; the assertions are relative to FILES. 120 files spent most of the
// file's time on simulated storage I/O (720 ops per cold read), ~10x slower on CI runners.
const FILES = 32;

async function repoWith(name: string, env: Env, policy: unknown = { required_checks: [], approvals: 0 }) {
  const owner = { cookie: await signup(name) };
  const files = [file('a.txt', 'good\n'), ...Array.from({ length: FILES }, (_, i) => file(`src/${i}.txt`, `${i}\n`))];
  const created = await api('/repos', owner, { body: { name, policy, files, author } }, env);
  expect(created.status).toBe(200);
  const repo = `/repos/${created.body.id}`;
  const tree = await api(`${repo}/tree?path=src`, owner, {}, env);
  const blobs = tree.body.entries.map((e: any) => ({ id: e.id, kind: 'blob' }));
  return { owner, id: created.body.id as string, repo, blobs };
}

/** Evicts blobs from both cache tiers (imports write through), leaving only the origin. */
async function evict(id: string, blobs: { id: string }[]) {
  for (const blob of blobs) {
    await bindings.OBJECTS.delete(`platform/v1/${id}/objects/${blob.id}`);
    await caches.default.delete(new Request(`https://objects.yoneda.internal/${id}/${blob.id}`));
  }
}

/** Reads `objects` through the API in pages, summing the tiers that served them. */
async function read(owner: { cookie: string }, repo: string, objects: unknown[], env: Env) {
  const tiers = { edge: 0, r2: 0, store: 0 };
  let after: number | null = null;
  do {
    const page = await api(`${repo}/objects`, owner, { body: { objects, after } }, env);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    for (const tier of Object.keys(tiers) as (keyof typeof tiers)[]) tiers[tier] += page.body.tiers[tier];
    after = page.body.next;
  } while (after !== null);
  return tiers;
}

/** An R2 binding whose cache-tier reads fail (the store's own keys still work). */
function r2CacheDown(repoId: string) {
  const real = bindings.OBJECTS;
  const down = (key: string) => key.startsWith(`platform/v1/${repoId}/objects/`);
  return {
    get: (key: string, ...rest: any[]) => (down(key) ? Promise.reject(new Error('R2 unavailable')) : (real.get as any)(key, ...rest)),
    put: (...args: any[]) => (real.put as any)(...args),
    head: (key: string) => real.head(key),
    delete: (keys: any) => real.delete(keys),
    list: (options: any) => real.list(options),
  };
}

it('records seed and object tiers in check-run evidence, cold then warm', async () => {
  const policy = { required_checks: ['unit'], approvals: 0, runners: { unit: { command: ['sh', '-c', 'test'], timeout_seconds: 30 } } };
  const { owner, id, repo } = await repoWith('tiered', local, policy);
  const run = async (path: string) => {
    const made = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file(path, 'x\n')], message: 'c', author } }, local);
    expect(await executeCheckRun(local, queued.filter((m) => m.kind === 'platform_check').at(-1))).toBeUndefined();
    const detail = await api(`${repo}/commits/${made.body.commit}`, owner, {}, local);
    return JSON.parse(detail.body.checks[0].evidence).tiers;
  };
  const cold = await run('src/1.txt');
  expect(cold).toMatchObject({ seed: 0, files: FILES + 1 });
  expect(cold.edge + cold.r2 + cold.store).toBeGreaterThan(FILES); // every blob plus trees
  await deriveAfterLanding(local, { v: 1, kind: 'platform_derive', repo_id: id, job_id: 'main' });
  const warm = await run('src/2.txt');
  expect(warm).toMatchObject({ seed: FILES, files: FILES + 1 });
  expect(warm.store).toBe(0);
  console.log(JSON.stringify({ measured: 'check-run tiers (local workerd)', cold, warm }));
});

it('an unavailable edge tier falls to R2, never to the origin', async () => {
  const { owner, id, repo, blobs } = await repoWith('edgedown', local);
  await evict(id, blobs);
  const cold = await read(owner, repo, blobs, local);
  expect(cold).toEqual({ edge: 0, r2: 0, store: FILES });
  expect(await read(owner, repo, blobs, local)).toEqual({ edge: FILES, r2: 0, store: 0 });
  vi.spyOn(caches.default, 'match').mockRejectedValue(new Error('cache unavailable'));
  vi.spyOn(caches.default, 'put').mockRejectedValue(new Error('cache unavailable'));
  const edgeDown = await read(owner, repo, blobs, local);
  expect(edgeDown).toEqual({ edge: 0, r2: FILES, store: 0 });
  console.log(JSON.stringify({ measured: 'edge tier down (local workerd)', cold, edgeDown }));
});

it('an unavailable R2 tier fails reads closed instead of stampeding the origin', async () => {
  const { owner, id, repo, blobs } = await repoWith('rtwodown', local);
  await read(owner, repo, blobs, local); // fills R2 and the edge
  vi.spyOn(caches.default, 'match').mockResolvedValue(undefined); // edge misses as well
  const env = { ...local, OBJECTS: r2CacheDown(id) } as unknown as Env;
  const page = await api(`${repo}/objects`, owner, { body: { objects: blobs.slice(0, 16) } }, env);
  expect(page.status).toBe(500);
  expect(page.body.error.message).toContain('R2 unavailable');
});

it('measures origin reads when many requests miss the same object at once', async () => {
  const { owner, id, repo, blobs } = await repoWith('herd', local);
  const one = [blobs[0]];
  await evict(id, one);
  const results = await Promise.all(Array.from({ length: 20 }, () => read(owner, repo, one, local)));
  const origin = results.reduce((sum, t) => sum + t.store, 0);
  // No request coalescing: each concurrent cold miss may read the origin once.
  expect(origin).toBeGreaterThanOrEqual(1);
  expect(origin).toBeLessThanOrEqual(20);
  console.log(JSON.stringify({ measured: 'concurrent cold misses, same object (local workerd)', requests: 20, origin_reads: origin }));
});

it('answers cold reads without waiting on a stalled edge tier', async () => {
  const { owner, id, repo, blobs } = await repoWith('edgestall', local);
  // Only the origin holds the first blob; R2 holds the second (a read from the origin
  // filled it), and its edge copy is gone.
  const edgeOf = (blob: { id: string }) => new Request(`https://objects.yoneda.internal/${id}/${blob.id}`);
  await caches.default.delete(edgeOf(blobs[1]));
  expect(await read(owner, repo, blobs.slice(1, 2), local)).toEqual({ edge: 0, r2: 0, store: 1 });
  await caches.default.delete(edgeOf(blobs[1]));
  await evict(id, blobs.slice(0, 1));
  // Hosted burst read-back (2026-10-28): Cache API calls of 24-33 s (`cache.edge`) held
  // reads, and every read of the same object in the isolate waited on the one that filled.
  const stall = () => new Promise<undefined>((done) => setTimeout(() => done(undefined), 3_000));
  vi.spyOn(caches.default, 'match').mockImplementation(stall);
  vi.spyOn(caches.default, 'put').mockImplementation(stall);
  const after: Promise<unknown>[] = [];
  try {
    const started = Date.now();
    const tiers = await withWaitUntil(
      (work) => after.push(work),
      () => read(owner, repo, blobs.slice(0, 2), local),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(tiers).toEqual({ edge: 0, r2: 1, store: 1 });
    expect(after.length).toBeGreaterThan(0); // the fills, after the answer
  } finally {
    await Promise.all(after);
  }
});

it('a read sharing another read of the same object does not wait for its cache fills', async () => {
  const { owner, id, repo, blobs } = await repoWith('edgejoin', local);
  await evict(id, blobs.slice(0, 1));
  vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);
  const put = vi
    .spyOn(caches.default, 'put')
    .mockImplementation(() => new Promise<undefined>((done) => setTimeout(() => done(undefined), 3_000)));
  // A job (no waitUntil: it writes its fills before it goes on) reads the object first; a
  // request in the same isolate asks for it while the job's fill is under way.
  const job = read(owner, repo, blobs.slice(0, 1), local);
  await vi.waitFor(() => expect(put).toHaveBeenCalled());
  const after: Promise<unknown>[] = [];
  try {
    const started = Date.now();
    await withWaitUntil(
      (work) => after.push(work),
      () => read(owner, repo, blobs.slice(0, 1), local),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    await Promise.all([job, ...after]);
  }
});

it('asks R2 once the edge is slower than the hedge, and never while the edge answers', async () => {
  const { owner, id, repo, blobs } = await repoWith('edgehedge', local);
  await read(owner, repo, blobs.slice(0, 2), local); // fills the edge
  const gets: string[] = [];
  const real = bindings.OBJECTS;
  const counted = { get: (key: string, ...rest: any[]) => (gets.push(key), (real.get as any)(key, ...rest)), head: (key: string) => real.head(key) };
  const env = { ...local, OBJECTS: counted } as unknown as Env;
  // The store is never reached: one of the cache tiers holds every blob.
  const tiers = () => new RepoObjects(env, id, {} as ObjectStore);
  const healthy = tiers();
  const bytes = await healthy.blob(blobs[1].id);
  expect(healthy.hits).toEqual({ edge: 1, r2: 0, store: 0 });
  expect(gets).toEqual([]);
  await real.put(`platform/v1/${id}/objects/${blobs[1].id}`, bytes, { customMetadata: { kind: 'blob' } });
  // Hosted burst read-backs (2026-10-28, bf7566e): 18 of the 19 edge lookups in the 15
  // slowest reads ran into the 500 ms cap, on objects R2 held (head trees), each read
  // paying it up to three times.
  vi.spyOn(caches.default, 'match').mockImplementation(() => new Promise((done) => setTimeout(() => done(undefined), 3_000)));
  const stalled = tiers();
  const started = Date.now();
  await stalled.blob(blobs[1].id);
  expect(Date.now() - started).toBeLessThan(250);
  expect(stalled.hits).toEqual({ edge: 0, r2: 1, store: 0 });
});
