// What bundle readers cost a repository: file reads and the Artifacts projection of one
// that holds no bundles (a burst of API landings) make no `repo_bundle_locate` call to its
// authority, and the per-isolate location memo stays bounded. Counts are of Durable Object
// commands in local workerd.
import { expect, it } from 'vitest';
import { isolateLocations, type Location, LocationMemo, locate } from '../../cloudflare/worker/repo-bundles';
import { projectObjects, projectRefs } from '../../cloudflare/worker/repo-projection';
import type { Env } from '../../cloudflare/worker/types';
import { api, artifacts, author, bindings, countingOps, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, PUSH_BUNDLES: 'on', LAND_MODE: 'batch' } as unknown as Env;

/** Drops `ids` from both cache tiers, as a cold colo and a lagging R2 fill would. */
async function evict(repo: string, ids: string[]) {
  for (const id of ids) {
    await bindings.OBJECTS.delete(`platform/v1/${repo}/objects/${id}`);
    await caches.default.delete(new Request(`https://objects.yoneda.internal/${repo}/${id}`));
  }
}

it('reads and projects a repository without bundles with no locate call', async () => {
  const { env, take } = countingOps(on);
  const owner = { cookie: await signup('unbundled') };
  const created = await api('/repos', owner, { body: { name: 'unbundled', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author } }, env);
  const repo = created.body.id as string;
  // Writers commit and land into main, as the burst does.
  const landed: { version: number; commit: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const made = await api(`/repos/${repo}/commits`, owner, { body: { ref: 'main', changes: [file(`w/${i}.txt`, `writer ${i}\n`)], message: `w${i}`, author } }, env);
    const land = await api(`/repos/${repo}/land`, owner, { body: { ref: 'main', commit: made.body.commit } }, env);
    expect(land.status, JSON.stringify(land.body)).toBe(200);
    landed.push({ version: land.body.version, commit: made.body.commit });
  }
  const tree = await api(`/repos/${repo}/tree?path=w&commit=${landed[3].commit}`, owner, {}, env);
  const blobs = tree.body.entries.map((e: { id: string }) => e.id);
  await evict(repo, blobs);
  take();

  // Each file at its landing's version, then at its commit: both before projection, so the
  // reads walk past the cache tiers to the staged copies.
  for (const [i, l] of landed.entries()) {
    const read = await api(`/repos/${repo}/blob?path=w/${i}.txt&min_version=${l.version}`, owner, {}, env);
    expect(read.body.content).toBe(`writer ${i}\n`);
  }
  await evict(repo, blobs);
  for (const [i, l] of landed.entries()) {
    const read = await api(`/repos/${repo}/blob?path=w/${i}.txt&commit=${l.commit}`, owner, {}, env);
    expect(read.body.content).toBe(`writer ${i}\n`);
  }
  const reads = take();
  expect(reads.repo_bundle_locate ?? 0).toBe(0);
  // One staged read per object that missed R2, as before bundles.
  expect(reads.repo_staged_objects).toBeLessThanOrEqual(8);

  // The consumer's jobs: staged objects to R2, then main (its batch's Git commit, built
  // when main is first read) to Artifacts.
  const head = (await api(`/repos/${repo}/refs`, owner, {}, env)).body.refs['refs/heads/main'];
  take();
  for (let round = 0; round < 3 && queued.length; round++)
    for (const message of queued.splice(0)) {
      if (message.kind === 'platform_objects') await projectObjects(env, message.repo_id, message.job_id);
      if (message.kind === 'platform_project') await projectRefs(env, message);
    }
  expect(take().repo_bundle_locate ?? 0).toBe(0);
  expect(artifacts.get(`yr-${repo}`)?.has(head)).toBe(true);
});

const place = (n: number): Location => ({ id: n.toString(16).padStart(40, '0'), bundle: 'b'.repeat(64), at: n, size: 1, kind: 'blob' });

it('keeps the location memo bounded, least recently used leaving first', async () => {
  const memo = new LocationMemo(100);
  memo.set('r', place(0));
  for (let n = 1; n < 1_000; n++) {
    expect(memo.get('r', place(0).id)).toBeDefined();
    memo.set('r', place(n));
  }
  expect(memo.size).toBe(100);
  expect(memo.get('r', place(1).id)).toBeUndefined();
  expect(memo.get('r', place(999).id)).toBeDefined();
  // Repositories known to hold bundles are bounded too.
  expect(memo.holds('r')).toBe(true);
  for (let n = 0; n < 2_000; n++) memo.bundled(`repo${n}`);
  expect(memo.holds('repo0')).toBe(false);
  expect(memo.holds('repo1999')).toBe(true);

  // The isolate's memo after locating 20,000 bundled objects (10 authority calls).
  isolateLocations.clear();
  let calls = 0;
  const answering = {
    SOURCE_REPOS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_: string, init: RequestInit) => {
          calls++;
          const { ids } = JSON.parse(String(init.body));
          return Response.json({ located: ids.map((id: string) => ({ ...place(0), id })) });
        },
      }),
    },
  } as unknown as Env;
  const wanted = Array.from({ length: 20_000 }, (_, n) => ({ id: place(n).id, kind: 'blob' }));
  expect((await locate(answering, 'big', wanted)).size).toBe(20_000);
  expect(calls).toBe(10);
  expect(isolateLocations.size).toBe(8_192);
  isolateLocations.clear();
});
