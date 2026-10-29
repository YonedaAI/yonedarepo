// Clones served from a stored pack (PACK_CACHE=on). A fetch that has nothing has its pack
// depend on its wants, filter and depth alone, so the first one is stored while it streams
// and later ones stream that object, with no bundle reads, deltas or zlib. Fetches with
// haves are built as before. Counts are of R2 reads in local workerd. Jobs that build
// packs are repo-pack-jobs.test.ts.
import { expect, it, vi } from 'vitest';
import { withWaitUntil } from '../../cloudflare/worker/background';
import { KEPT, PART, PackWriter } from '../../cloudflare/worker/repo-pack-cache';
import { Storing } from '../../cloudflare/worker/repo-pack-stream';
import { bindings, scoped, usePlatformFixture } from './repo-fixture';
import { count, fetchV2, hex, history, on, pkt, pushedRepo, reads, request } from './repo-pack-fixture';

usePlatformFixture();

it('serves each kind of clone from the pack the first one stored', async () => {
  const { repo, token, push, objects, tip } = await pushedRepo('pack_cache', on);

  // The first clone builds the pack from the bundles and stores it.
  let first: Uint8Array | string = '';
  const built = await reads(repo, async () => (first = await fetchV2(on, repo, token, [`want ${tip}`, 'done'])));
  expect(count(first)).toBe(1 + 6 * 4 + 2);
  expect(built.bundles).toBeGreaterThan(0);
  const stored = await bindings.OBJECTS.list({ prefix: `derived/v1/${repo}/packs/` });
  expect(stored.objects.some((o) => o.key.endsWith('.pack'))).toBe(true);

  // The next one streams that pack: the same bytes, no bundle read.
  let second: Uint8Array | string = '';
  const served = await reads(repo, async () => (second = await fetchV2(on, repo, token, [`want ${tip}`, 'done'])));
  expect(served).toEqual({ bundles: 0, packs: 1 });
  expect(second).toEqual(first);
  // Version 0 clones with the same wants share it.
  const v0 = await reads(repo, () => request(on, repo, token, 'git-upload-pack', `${pkt(`want ${tip} side-band-64k\n`)}0000${pkt('done\n')}`));
  expect(v0).toEqual({ bundles: 0, packs: 1 });

  // A partial clone is never served the full clone's pack (this one, of commits and trees
  // only, is too small for a clone to store).
  const partial = await reads(repo, async () => expect(count(await fetchV2(on, repo, token, [`want ${tip}`, 'filter blob:none', 'done']))).toBe(2 + 6 * 3));
  expect(partial.bundles).toBeGreaterThan(0);
  // A shallow clone and a checkout's files wanted by id (neither has anything) store packs
  // of their own, and later ones stream them.
  const fresh = [
    [[`want ${tip}`, 'deepen 1', 'done'], 1 + 2 + 6],
    [[...objects.filter((o) => o.kind === 'blob').map((o) => `want ${o.id}`), 'filter blob:none', 'done'], 6],
  ] as const;
  for (const [args, objectCount] of fresh) {
    let built: Uint8Array | string = '';
    const first = await reads(repo, async () => (built = await fetchV2(on, repo, token, args)));
    expect(count(built)).toBe(objectCount);
    expect(first.bundles).toBeGreaterThan(0);
    let again: Uint8Array | string = '';
    const hit = await reads(repo, async () => (again = await fetchV2(on, repo, token, args)));
    expect(hit).toEqual({ bundles: 0, packs: 1 });
    expect(again).toEqual(built);
  }
  // A fetch with haves is built for what it lacks, and a shallow one deepened likewise.
  const incremental = await reads(repo, async () => expect(count(await fetchV2(on, repo, token, [`want ${tip}`, `have ${objects[4].id}`, 'done']))).toBe(4));
  expect(incremental.packs).toBe(0);
  const deeper = await reads(repo, () => fetchV2(on, repo, token, [`want ${tip}`, `shallow ${tip}`, 'deepen 1', 'done']));
  expect(deeper.packs).toBe(0);

  // A push moves the tip: a clone of it builds and stores its own pack.
  const more = await history(tip, 1, 'later ');
  await push(tip, more);
  const after = await reads(repo, async () => expect(count(await fetchV2(on, repo, token, [`want ${more[0].id}`, 'done']))).toBe(3 + 7 * 4));
  expect(after.bundles).toBeGreaterThan(0);
});

const digest = async (bytes: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const at = (repo: string, name: string) => `derived/v1/${repo}/packs/v2/${name}.pack`;
const packs = async (repo: string) =>
  (await bindings.OBJECTS.list({ prefix: `derived/v1/${repo}/packs/v2/` })).objects
    .map((o) => o.key)
    .filter((k) => k.endsWith('.pack'))
    .sort();

/** A writer of `size` bytes offered as a clone streams them. */
async function offered(repo: string, key: string, size: number, tip?: string) {
  const writer = new PackWriter(scoped, repo, key, PART, tip);
  const data = new Uint8Array(size).map((_, i) => (i * 31 + size) % 251);
  for (let i = 0; i < data.length; i += 65_515) {
    expect(writer.offer(data.subarray(i, i + 65_515))).toBe(true);
    // R2 takes each part before the next one fills (a clone streams slower than that).
    if ((i + 65_515) % PART < 65_515) await new Promise((r) => setTimeout(r, 200));
  }
  return { writer, data };
}

it('stores a pack of several parts, nothing when aborted, and keeps the four most recent', async () => {
  const big = await offered('rpackwriter', at('rpackwriter', 'big'), PART * 2 + 12_345);
  expect(await bindings.OBJECTS.head(at('rpackwriter', 'big'))).toBeNull();
  expect(await big.writer.finish()).toBe(true);
  const stored = new Uint8Array(await ((await bindings.OBJECTS.get(at('rpackwriter', 'big'))) as R2ObjectBody).arrayBuffer());
  expect([stored.length, await digest(stored)]).toEqual([big.data.length, await digest(big.data)]);

  const dropped = await offered('rpackwriter', at('rpackwriter', 'dropped'), PART + 1);
  await dropped.writer.abort();
  expect(await bindings.OBJECTS.head(at('rpackwriter', 'dropped'))).toBeNull();
  // A small pack is not worth a clone's keeping (a job keeps what it built).
  expect(await (await offered('rpackwriter', at('rpackwriter', 'small'), 1_000)).writer.finish()).toBe(false);
  expect(await bindings.OBJECTS.head(at('rpackwriter', 'small'))).toBeNull();
  expect(await (await offered('rpackwriter', at('rpackwriter', 'job'), 1_000)).writer.finish(0)).toBe(true);

  const names = ['p1', 'p2', 'p3', 'p4', 'p5'];
  for (const name of names) await (await offered('rpackwriter', at('rpackwriter', name), 300_000)).writer.finish();
  expect(KEPT).toBe(4);
  expect(await packs('rpackwriter')).toEqual(['p2', 'p3', 'p4', 'p5'].map((n) => at('rpackwriter', n)));
});

it('deletes the packs built for an earlier tip once a later tip’s are stored', async () => {
  const repo = 'rpacktips';
  for (const name of ['a-full', 'a-partial', 'a-shallow']) await (await offered(repo, at(repo, name), 1_000, 'a')).writer.finish(0);
  // A clone's own (no tip) is kept until it is among the oldest.
  await (await offered(repo, at(repo, 'checkout'), 300_000)).writer.finish();
  expect(await packs(repo)).toHaveLength(4);
  await (await offered(repo, at(repo, 'b-full'), 1_000, 'b')).writer.finish(0);
  expect(await packs(repo)).toEqual(['b-full', 'checkout'].map((n) => at(repo, n)));
  for (const name of ['b-partial', 'b-shallow', 'b-more']) await (await offered(repo, at(repo, name), 1_000, 'b')).writer.finish(0);
  expect(await packs(repo)).toEqual(['b-full', 'b-more', 'b-partial', 'b-shallow'].map((n) => at(repo, n)));
});

it('holds three parts of a pack at most: a store two parts behind the clone is given up', async () => {
  const key = 'derived/v1/rpackslow/packs/v2/slow.pack';
  // R2 starts the upload but never takes a part.
  const create = vi.spyOn(scoped.OBJECTS, 'createMultipartUpload').mockImplementation((async () => ({
    uploadPart: () => new Promise(() => {}),
    abort: async () => {},
  })) as any);
  try {
    const writer = new PackWriter(scoped, 'rpackslow', key);
    const piece = new Uint8Array(65_515);
    let taken = 0;
    while (taken < 4 * PART && writer.offer(piece)) taken += piece.length;
    // Two parts are on their way up; the third filled while they were: refused, not queued.
    expect(taken).toBeLessThan(3 * PART);
    expect(taken).toBeGreaterThanOrEqual(3 * PART - piece.length);
    expect(create).toHaveBeenCalledTimes(1);

    // A clone's store that falls behind hands the pack to a job, once, behind the answer.
    const handed: string[] = [];
    const later: Promise<unknown>[] = [];
    const storing = withWaitUntil(
      (work) => void later.push(work),
      () => new Storing(new PackWriter(scoped, 'rpackslow', key), undefined, async () => void handed.push(key)),
    );
    for (let sent = 0; sent < 4 * PART; sent += piece.length) storing.add(piece);
    await Promise.all(later);
    expect(handed).toEqual([key]);
  } finally {
    create.mockRestore();
  }
  expect(await bindings.OBJECTS.head(key)).toBeNull();
});

it('never holds a clone back on the store: a stalled store is left behind the answer', async () => {
  const { repo, token, objects } = await pushedRepo('pack_cache_stall', on);
  // R2 never answers a write of a stored pack.
  const put = scoped.OBJECTS.put.bind(scoped.OBJECTS);
  const stall = vi.spyOn(scoped.OBJECTS, 'put').mockImplementation(((key: string, ...rest: unknown[]) =>
    key.includes('/packs/') ? new Promise(() => {}) : (put as any)(key, ...rest)) as any);
  const later: Promise<unknown>[] = [];
  try {
    const pack = await withWaitUntil((work) => void later.push(work), () => fetchV2(on, repo, token, [`want ${objects[0].id}`, 'done']));
    expect(count(pack)).toBe(1 + 6 * 4 + 2);
    expect(later).toHaveLength(1);
  } finally {
    stall.mockRestore();
  }
  expect((await bindings.OBJECTS.list({ prefix: `derived/v1/${repo}/packs/` })).objects).toEqual([]);
});
