// Stored packs built by jobs (repo-pack-jobs) in the repository's PackBuilder container
// (pack-builder.ts; a test double here, answering with what the platform builds): a clone
// that cannot store its pack hands it over, and a push to main builds that tip's full,
// partial and shallow clone packs after a debounce, one build at a time, deleting the
// earlier tip's. The container answers its Git remotes only for its own repository. Counts
// are of R2 reads in local workerd.
import { beforeEach, expect, it, vi } from 'vitest';
import { withWaitUntil } from '../../cloudflare/worker/background';
import { buildPacks, mirrorSource, platformSource } from '../../cloudflare/worker/pack-builder';
import { packKey } from '../../cloudflare/worker/repo-pack-cache';
import { DEBOUNCE_S } from '../../cloudflare/worker/repo-pack-jobs';
import type { Env } from '../../cloudflare/worker/types';
import { bindings, fakeQueue, usePlatformFixture } from './repo-fixture';
import { count, drainPackBuilds, fakeBuilders, fetchV2, history, on, pkt, pushedRepo, reads, runJob, take } from './repo-pack-fixture';

usePlatformFixture();

const builders = fakeBuilders(() => jobs);
/** Jobs build packs of any size here (the fixtures' are a few dozen objects). */
const jobs = { ...on, PACK_BUILD_MIN_OBJECTS: '0', PACK_BUILDERS: builders.namespace } as unknown as Env;
/** This isolate's Wasm is over the clone's store limit: every clone hands its pack over. */
const crowded = { ...jobs, PACK_STORE_WASM_MIB: '0' } as unknown as Env;

beforeEach(() => {
  builders.record.calls.length = 0;
  builders.record.started = 0;
  builders.record.destroyed = 0;
});

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

it('hands a pack it cannot store to a container job, which stores it for the next clone of each kind', async () => {
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
    expect(count(again), kind).toBe(count(first));
  }
  // One container start per build, each destroyed after it.
  expect([builders.record.started, builders.record.destroyed]).toEqual([4, 4]);
  // The job's records of what was asked are gone once it settled.
  const left = (await bindings.OBJECTS.list({ prefix: `derived/v1/${repo}/packs/v2/` })).objects.map((o) => o.key);
  expect(left.filter((k) => !k.endsWith('.pack') && !k.endsWith('/recent'))).toEqual([]);
});

it('builds main’s clone packs in one container start after a push, once the pushes settle, and deletes the earlier tip’s', async () => {
  const send = vi.spyOn(fakeQueue, 'send');
  const { repo, token, push, tip } = await pushedRepo('pack_after_push', jobs);
  // The derive job after the landing schedules main's build DEBOUNCE_S later.
  for (const derive of take('platform_derive')) await runJob(jobs, derive);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'platform_pack_build', job_id: `push-${tip}` }), { delaySeconds: DEBOUNCE_S });
  const scheduled = take('platform_pack_build');

  // Main moves again before it runs: that job builds nothing; the later tip's builds.
  const more = await history(tip, 1, 'later ');
  await push(tip, more);
  for (const derive of take('platform_derive')) await runJob(jobs, derive);
  for (const message of scheduled) await runJob(jobs, message);
  expect(await packs(repo)).toEqual([]);
  expect(builders.record.started).toBe(0);
  const later = more[0].id;
  expect(await drainPackBuilds(jobs)).toEqual([`push-${later}`]);
  expect(await packs(repo)).toHaveLength(3);
  expect(builders.record.calls).toEqual(['/fetch', '/pack', '/stats', '/pack?filter=blob:none', '/stats', '/pack?depth=1', '/stats']);
  expect([builders.record.started, builders.record.destroyed]).toEqual([1, 1]);

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
  await runJob(jobs, { v: 1, kind: 'platform_pack_build', repo_id: repo, job_id: `push-${tip}` });
  expect(await packs(repo)).toEqual([]);
  expect(take('platform_pack_build').map((m) => m.job_id)).toEqual([`push-${tip}`]);
  // An expired lease (its build died) is taken over.
  await bindings.OBJECTS.put(`derived/v1/${repo}/packs/v2/building`, 'held', { customMetadata: { until: String(Date.now() - 1) } });
  await runJob(jobs, { v: 1, kind: 'platform_pack_build', repo_id: repo, job_id: `push-${tip}` });
  expect(await packs(repo)).toHaveLength(3);
  expect(await bindings.OBJECTS.head(`derived/v1/${repo}/packs/v2/building`)).toBeNull();
});

it('builds nothing for a repository under PACK_BUILD_MIN_OBJECTS, or without containers', async () => {
  const small = { ...jobs, PACK_BUILD_MIN_OBJECTS: '5000' } as unknown as Env;
  const { repo, tip } = await pushedRepo('pack_small', small);
  take('platform_derive');
  await runJob(small, { v: 1, kind: 'platform_pack_build', repo_id: repo, job_id: `push-${tip}` });
  expect(await packs(repo)).toEqual([]);
  expect(builders.record.calls).toEqual(['/fetch']);
  expect(builders.record.destroyed).toBe(1);
  // Without a PackBuilder binding a push schedules nothing.
  const send = vi.spyOn(fakeQueue, 'send');
  const { schedulePackBuild } = await import('../../cloudflare/worker/repo-pack-jobs');
  await schedulePackBuild(on, repo, tip);
  expect(send).not.toHaveBeenCalled();
});

it('never keeps a pack the container cut short, and destroys the container whatever happens', async () => {
  const cut = fakeBuilders(() => broken, { packs: (_, pack) => pack.subarray(0, pack.length - 7) });
  const broken = { ...jobs, PACK_BUILDERS: cut.namespace } as unknown as Env;
  const { repo, tip } = await pushedRepo('pack_cut', broken);
  take('platform_derive');
  // The job fails (the queue retries it) with nothing kept and the lease released.
  await expect(runJob(broken, { v: 1, kind: 'platform_pack_build', repo_id: repo, job_id: `push-${tip}` })).rejects.toThrow('incomplete pack');
  expect(await bindings.OBJECTS.head(`derived/v1/${repo}/packs/v2/building`)).toBeNull();
  expect(await packs(repo)).toEqual([]);
  expect(cut.record.destroyed).toBe(1);
  // A container that does not start is destroyed too, and the job fails (the queue retries).
  const instance = { startAndWaitForPorts: async () => Promise.reject(new Error('no capacity')), containerFetch: async () => new Response(), destroy: vi.fn(async () => {}) };
  await expect(buildPacks(instance, jobs, { repo, packs: [], minObjects: 0 }, async () => false)).rejects.toThrow('no capacity');
  expect(instance.destroy).toHaveBeenCalledTimes(1);
});

it('keeps no pack once a blob is withheld while it was built', async () => {
  const late = fakeBuilders(() => quarantined, { withheld: async () => true });
  const quarantined = { ...jobs, PACK_BUILDERS: late.namespace } as unknown as Env;
  const { repo, tip } = await pushedRepo('pack_late_quarantine', quarantined);
  take('platform_derive');
  const logs = vi.spyOn(console, 'log');
  await runJob(quarantined, { v: 1, kind: 'platform_pack_build', repo_id: repo, job_id: `push-${tip}` });
  expect(late.record.calls.filter((c) => c.startsWith('/pack'))).toHaveLength(3);
  expect(await packs(repo)).toEqual([]);
  const report = logs.mock.calls.map(([line]) => String(line)).find((line) => line.includes('"git.pack.build"'));
  expect(JSON.parse(report ?? '{}').packs.map((p: { outcome: string }) => p.outcome)).toEqual(['withheld', 'withheld', 'withheld']);
});

it('answers a container’s Git remotes only for its own repository', async () => {
  const { repo, tip } = await pushedRepo('pack_sources', jobs);
  const own = { containerId: `id:packs:${repo}` };
  const other = { containerId: 'id:packs:r00000000000000000000' };
  const at = (host: string, path: string, init?: RequestInit) => new Request(`http://${host}/${repo}.git/${path}`, { headers: { 'git-protocol': 'version=2' }, ...init });
  const refs = 'info/refs?service=git-upload-pack';
  expect((await platformSource(at('platform.internal', refs), jobs, other)).status).toBe(403);
  expect((await mirrorSource(at('mirror.internal', refs), jobs, other)).status).toBe(403);
  // Only upload-pack's two requests.
  expect((await platformSource(at('platform.internal', 'info/refs?service=git-receive-pack'), jobs, own)).status).toBe(403);
  expect((await platformSource(at('platform.internal', refs), jobs, own)).status).toBe(200);
  const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${pkt(`want ${tip}\n`)}${pkt('done\n')}0000`;
  const fetched = await platformSource(at('platform.internal', 'git-upload-pack', { method: 'POST', body }), jobs, own);
  expect(new TextDecoder('latin1').decode(new Uint8Array(await fetched.arrayBuffer()))).toContain('packfile');
  // Git gzips a large request (a checkout's thousands of wanted blobs).
  const gzipped = new Response(new Response(body).body?.pipeThrough(new CompressionStream('gzip')));
  const zipped = { method: 'POST', body: await gzipped.arrayBuffer(), headers: { 'git-protocol': 'version=2', 'content-encoding': 'gzip' } };
  const unzipped = await platformSource(at('platform.internal', 'git-upload-pack', zipped), jobs, own);
  expect(new TextDecoder('latin1').decode(new Uint8Array(await unzipped.arrayBuffer()))).toContain('packfile');
  // The mirror is the repository's Artifacts remote, with a read token the Worker minted.
  const remote = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('refs'));
  expect(await (await mirrorSource(at('mirror.internal', refs), jobs, own)).text()).toBe('refs');
  const [target, init] = remote.mock.calls[0] as [string, RequestInit];
  expect(target).toMatch(/^https:\/\/artifacts\.test\/.+\/info\/refs\?service=git-upload-pack$/);
  expect(new Headers(init.headers).get('authorization')).toMatch(/^Bearer .+/);
  expect(new Headers(init.headers).get('git-protocol')).toBe('version=2');
});
