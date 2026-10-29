// Stored packs built by jobs (repo-pack-jobs): a clone that cannot store its pack hands it
// over, and a push to main builds that tip's full, partial and shallow clone packs after a
// debounce, one build at a time, deleting the earlier tip's. Counts are of R2 reads in
// local workerd.
import { expect, it, vi } from 'vitest';
import { withWaitUntil } from '../../cloudflare/worker/background';
import { packKey } from '../../cloudflare/worker/repo-pack-cache';
import { DEBOUNCE_S } from '../../cloudflare/worker/repo-pack-jobs';
import type { Env } from '../../cloudflare/worker/types';
import { bindings, fakeQueue, usePlatformFixture } from './repo-fixture';
import { count, drainPackBuilds, fetchV2, history, on, pushedRepo, reads, runJob, take } from './repo-pack-fixture';

usePlatformFixture();

/** Jobs build packs of any size here (the fixtures' are a few dozen objects). */
const jobs = { ...on, PACK_BUILD_MIN_OBJECTS: '0' } as unknown as Env;
/** This isolate's Wasm is over the clone's store limit: every clone hands its pack over. */
const crowded = { ...jobs, PACK_STORE_WASM_MIB: '0' } as unknown as Env;

const packs = async (repo: string) =>
  (await bindings.OBJECTS.list({ prefix: `derived/v1/${repo}/packs/v2/` })).objects.map((o) => o.key).filter((k) => k.endsWith('.pack'));

/** What a clone, a partial clone, a shallow clone and a partial clone's checkout ask. */
const kinds = (tip: string, blobs: string[]) =>
  ({
    full: [`want ${tip}`, 'done'],
    partial: [`want ${tip}`, 'filter blob:none', 'done'],
    shallow: [`want ${tip}`, 'deepen 1', 'done'],
    checkout: [...blobs.map((b) => `want ${b}`), 'filter blob:none', 'done'],
  }) as const;

it('hands a pack it cannot store to a job, which stores it for the next clone of each kind', async () => {
  const { repo, token, objects, tip } = await pushedRepo('pack_handoff', crowded);
  take('platform_derive');
  const blobs = objects.filter((o) => o.kind === 'blob').map((o) => o.id);
  for (const [kind, args] of Object.entries(kinds(tip, blobs))) {
    const later: Promise<unknown>[] = [];
    const first = await withWaitUntil((work) => void later.push(work), () => fetchV2(crowded, repo, token, args));
    await Promise.all(later);
    expect(await packs(repo), kind).toHaveLength(Object.keys(kinds(tip, blobs)).indexOf(kind));
    // A second clone before the job ran queues nothing more.
    await withWaitUntil((work) => void later.push(work), () => fetchV2(crowded, repo, token, args));
    await Promise.all(later);
    expect(await drainPackBuilds(crowded), kind).toHaveLength(1);
    let again: Uint8Array | string = '';
    const hit = await reads(repo, async () => (again = await fetchV2(crowded, repo, token, args)));
    expect(hit, kind).toEqual({ bundles: 0, packs: 1 });
    expect(again, kind).toEqual(first);
    expect(count(again), kind).toBeGreaterThan(0);
  }
  // The job's records of what was asked are gone once it settled.
  const left = (await bindings.OBJECTS.list({ prefix: `derived/v1/${repo}/packs/v2/` })).objects.map((o) => o.key);
  expect(left.filter((k) => !k.endsWith('.pack') && !k.endsWith('/recent'))).toEqual([]);
});

it('builds main’s clone packs after a push, once the pushes settle, and deletes the earlier tip’s', async () => {
  const send = vi.spyOn(fakeQueue, 'send');
  const { repo, token, push, tip } = await pushedRepo('pack_after_push', jobs);
  // The derive job after the landing schedules main's build DEBOUNCE_S later.
  for (const derive of take('platform_derive')) await runJob(jobs, derive);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'platform_pack_build', job_id: `push-0-${tip}` }), { delaySeconds: DEBOUNCE_S });
  const scheduled = take('platform_pack_build');

  // Main moves again before it runs: that job builds nothing; the later tip's builds.
  const more = await history(tip, 1, 'later ');
  await push(tip, more);
  for (const derive of take('platform_derive')) await runJob(jobs, derive);
  for (const message of scheduled) await runJob(jobs, message);
  expect(await packs(repo)).toEqual([]);
  const later = more[0].id;
  expect(await drainPackBuilds(jobs)).toEqual([0, 1, 2].map((step) => `push-${step}-${later}`));
  expect(await packs(repo)).toHaveLength(3);

  // The first clone of each kind is already one R2 read.
  for (const [kind, args] of Object.entries(kinds(later, []))) {
    if (kind === 'checkout') continue;
    const hit = await reads(repo, async () => expect(count(await fetchV2(jobs, repo, token, args)), kind).toBeGreaterThan(0));
    expect(hit, kind).toEqual({ bundles: 0, packs: 1 });
  }
  const built = new Set(await packs(repo));

  // The next push's packs replace them.
  const third = await history(later, 1, 'third ');
  await push(later, third);
  for (const derive of take('platform_derive')) await runJob(jobs, derive);
  await drainPackBuilds(jobs);
  const now = await packs(repo);
  expect(now).toHaveLength(3);
  expect(now.filter((k) => built.has(k))).toEqual([]);
  expect(await bindings.OBJECTS.head(await packKey(repo, { wants: [third[0].id], omit_blobs: false, depth: 1, deepen_relative: false }))).not.toBeNull();
});

it('builds one pack at a time per repository: a busy job comes back later', async () => {
  const { repo, tip } = await pushedRepo('pack_busy', jobs);
  take('platform_derive');
  await bindings.OBJECTS.put(`derived/v1/${repo}/packs/v2/building`, 'held', { customMetadata: { until: String(Date.now() + 60_000) } });
  await runJob(jobs, { v: 1, kind: 'platform_pack_build', repo_id: repo, job_id: `push-0-${tip}` });
  expect(await packs(repo)).toEqual([]);
  expect(take('platform_pack_build').map((m) => m.job_id)).toEqual([`push-0-${tip}`]);
  // An expired lease (its build died) is taken over.
  await bindings.OBJECTS.put(`derived/v1/${repo}/packs/v2/building`, 'held', { customMetadata: { until: String(Date.now() - 1) } });
  await runJob(jobs, { v: 1, kind: 'platform_pack_build', repo_id: repo, job_id: `push-0-${tip}` });
  expect(await packs(repo)).toHaveLength(1);
  expect(await bindings.OBJECTS.head(`derived/v1/${repo}/packs/v2/building`)).toBeNull();
});

it('builds nothing for a repository under PACK_BUILD_MIN_OBJECTS', async () => {
  const { repo, tip } = await pushedRepo('pack_small', on);
  take('platform_derive');
  await runJob(on, { v: 1, kind: 'platform_pack_build', repo_id: repo, job_id: `push-0-${tip}` });
  expect(await drainPackBuilds(on)).toEqual([]);
  expect(await packs(repo)).toEqual([]);
});
