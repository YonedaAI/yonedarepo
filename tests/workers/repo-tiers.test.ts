// P5 / Scion S12: per-tier hit counts for the object path (seed -> Cache API -> R2 ->
// object store) and what a failing cache tier does to the origin. Measurements, labelled:
// local workerd with R2 standing in for the object store.
import { expect, it, vi } from 'vitest';
import { executeCheckRun } from '../../cloudflare/worker/repo-checks';
import { deriveAfterLanding } from '../../cloudflare/worker/repo-derived';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
const FILES = 120;

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
    expect(await executeCheckRun(local, queued.filter((m) => m.kind === 'platform_check').at(-1))).toEqual({});
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
