// Complexity gates: what a read costs in R2 bundle bytes must scale with what the request
// needs, not with the repository's history. Each gate pushes a synthetic history in one
// push (bundles on), reads it once in a fresh isolate, and compares the bytes R2 returned
// for the repository's bundles (ranged reads count their range) with the frames (25-byte
// header + content) of the objects the request needed. Clones are also gated walk and
// pack apart, on the fetch's own PackStats line (checked against the binding's count).
// Counts are of R2 reads in local workerd. Gates marked `it.fails` are known-failing: each
// names today's measured ratio and its target, and starts passing (so failing as
// `it.fails`) once a fix meets the target.
import { expect, it, vi } from 'vitest';
import { SEEN } from '../../cloudflare/worker/repo-git-objects';
import { blob, commitObject, fetchTimed, objectReads, pushHistory, type Raw, sorted, tree } from './pushed-history';
import { api, scoped, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

/** Bytes read per byte wanted that a gate allows, plus one 64 KiB gap bridged (the
 * ranged-read gap for scattered reads), so a request wanting a few KiB is not held to 2x. */
const SLACK = 2;
const ALLOWANCE = 64 * 1024;
const frames = (objects: Raw[]) => objects.reduce((n, o) => n + 25 + o.data.length, 0);
const mib = (n: number) => `${(n / 1048576).toFixed(2)}MiB`;

type History = { objects: Raw[]; head: Raw[]; logs: Raw[] };
/** Directory levels of `rewrites` (the root, d, e, f): a walk round each. */
const LEVELS = 4;

/** `commits` commits on `parent`, each rewriting one of `slots` files of about `size` bytes
 * under d/e/f/ and appending a line to log.txt: four new trees and two files per commit,
 * newest first. `head` is the tip's trees and files; `logs` every version of log.txt. */
async function rewrites(parent: string, commits: number, slots: number, size: number): Promise<History> {
  const objects: Raw[] = [];
  const logs: Raw[] = [];
  const files = new Map<string, string>();
  let head: Raw[] = [];
  for (let i = 0; i < commits; i++) {
    const name = `s${i % slots}.txt`;
    const content = await blob(`${`${name} version ${i} `.repeat(size / 20)}\n`);
    files.set(name, content.id);
    const f = await tree(sorted([...files].map(([n, id]) => ['100644', n, id])));
    const e = await tree([['40000', 'f', f.id]]);
    const d = await tree([['40000', 'e', e.id]]);
    const log = await blob(Array.from({ length: i + 1 }, (_, k) => `step ${k}\n`).join(''));
    const root = await tree([
      ['40000', 'd', d.id],
      ['100644', 'log.txt', log.id],
    ]);
    const commit = await commitObject(root.id, parent, i);
    objects.unshift(commit, root, d, e, f, content, log);
    logs.push(log);
    parent = commit.id;
    head = [root, d, e, f, log, ...objects.filter((o) => [...files.values()].includes(o.id))];
  }
  return { objects, head: [...new Map(head.map((o) => [o.id, o])).values()], logs };
}

/** A repository holding `commits` rewrites of 4 files of 140 KB (more than the 64 KiB gap
 * bundle reads bridge for scattered reads, less than the 1 MiB a clone bridges). */
async function pushed(name: string, commits: number) {
  let history: History | undefined;
  const repo = await pushHistory(name, async (main) => {
    history = await rewrites(main, commits, 4, 140_000);
    return history.objects;
  });
  return { ...repo, history: history as History };
}

/** Logs a gate's measurement; answers whether it is within the bound. */
function within(gate: string, read: { reads: number; others: number; bytes: number }, wanted: number) {
  const ratio = (read.bytes / wanted).toFixed(2);
  console.log(`${gate}: reads=${read.reads} others=${read.others} read=${mib(read.bytes)} wanted=${mib(wanted)} ratio=${ratio}`);
  return read.bytes <= SLACK * wanted + ALLOWANCE;
}

/** What a clone read, split as PackStats reports it (walk: the trees the walk asked for;
 * pack: the commits and files the pack sent), checked against the binding's own count. */
async function clone(repo: string, token: string, args: string[]) {
  let fetched: Awaited<ReturnType<typeof fetchTimed>> | undefined;
  const total = await objectReads(repo, async () => (fetched = await fetchTimed(repo, token, args)));
  const { count, timing } = fetched as NonNullable<typeof fetched>;
  // PackStats counts every ranged read the binding saw (sizes are rounded to 0.1 MiB).
  expect(timing.walk_reads + timing.reads).toBe(total.reads);
  expect(Math.abs(timing.walk_read + timing.read - total.bytes / 1048576)).toBeLessThanOrEqual(0.1);
  return { count, timing, total };
}

/** A push writes bundles of about 4 MiB (repo-git-receive WRITE_BUDGET), so `bytes` of
 * objects kept together span at most this many bundles. */
const spanned = (bytes: number) => Math.ceil(bytes / (4 * 1048576)) + 1;

/** The walk reads trees from the few bundles that hold the commits and trees, a read per
 * bundle plus at most one per directory level (`levels`): not a read per bundle of the
 * push (the old layout interleaved them with files: dev read 67 times across 36 bundles,
 * 96.2 MiB, for 0.5 MiB of trees). Its bytes get one bridged 1 MiB gap of slack (and 0.1
 * MiB of rounding): a small walk reads about twice what it wants (dev, new layout: 1.0 MiB
 * for 0.5). */
function walkReadsTreesOnly(timing: Record<string, number>, treeBytes: number, levels: number) {
  expect(timing.walk_bundles).toBeLessThanOrEqual(spanned(treeBytes));
  expect(timing.walk_reads).toBeLessThanOrEqual(spanned(treeBytes) + levels);
  expect(timing.walk_read).toBeLessThanOrEqual(2 * timing.walk_wanted + 1.1);
}

/** The pack reads what it sends, about once (dev, new layout: 168.2 MiB for 168.2). */
function packReadOnce(timing: Record<string, number>) {
  expect(timing.read).toBeLessThanOrEqual(1.1 * timing.wanted + 0.1);
}

it('a partial clone reads its commits and trees, never the files between them', async () => {
  for (const commits of [12, 60]) {
    const { repo, token, tip, history } = await pushed(`gate_partial_${commits}`, commits);
    const wanted = frames(history.objects.filter((o) => o.kind !== 'blob'));
    const { count, timing, total } = await clone(repo, token, [`want ${tip}`, 'filter blob:none', 'done']);
    // The pushed commits and trees, and the seed commit and its tree.
    expect(count).toBe(history.objects.length - commits * 2 + 2);
    console.log(`partial clone, ${commits} commits: ${JSON.stringify(timing)}`);
    walkReadsTreesOnly(timing, wanted, LEVELS);
    expect(timing.bundles).toBeLessThanOrEqual(spanned(wanted));
    packReadOnce(timing);
    expect(within(`partial clone, ${commits} commits`, total, wanted)).toBe(true);
  }
});

it('a full clone reads each bundled byte about once', async () => {
  for (const commits of [12, 60]) {
    const { repo, token, tip, history } = await pushed(`gate_full_${commits}`, commits);
    const { count, timing, total } = await clone(repo, token, [`want ${tip}`, 'done']);
    // The pushed objects and the seed commit's tree, file and commit.
    expect(count).toBe(history.objects.length + 3);
    console.log(`full clone, ${commits} commits: ${JSON.stringify(timing)}`);
    walkReadsTreesOnly(timing, frames(history.objects.filter((o) => o.kind !== 'blob')), LEVELS);
    packReadOnce(timing);
    expect(within(`full clone, ${commits} commits`, total, frames(history.objects))).toBe(true);
  }
});

/** `commits` commits on `parent` over a root of `dirs` directories, each commit rewriting
 * one directory's file: a root tree of `dirs` entries per commit, newest first. */
async function wideRoots(parent: string, commits: number, dirs: number) {
  const objects: Raw[] = [];
  const dir = async (d: number, version: number) => {
    const content = await blob(`dir ${d} version ${version}\n`);
    const t = await tree([['100644', 'f.txt', content.id]]);
    objects.unshift(t, content);
    return t.id;
  };
  const names = Array.from({ length: dirs }, (_, d) => `d${String(d).padStart(4, '0')}`);
  const ids: string[] = [];
  for (let d = 0; d < dirs; d++) ids.push(await dir(d, 0));
  for (let i = 0; i < commits; i++) {
    if (i > 0) ids[(i * 7) % dirs] = await dir((i * 7) % dirs, i);
    const root = await tree(names.map((name, d) => ['40000', name, ids[d]] as [string, string, string]));
    const commit = await commitObject(root.id, parent, i);
    objects.unshift(commit, root);
    parent = commit.id;
  }
  return objects;
}

it('a partial clone whose trees the session cannot keep reads each tree bundle about once', async () => {
  // 700 roots of 900 entries (21 MiB): more trees than the session keeps (TREE_BYTES), in 3
  // waves of commits, so each wave and both passes need trees an earlier one dropped.
  let objects: Raw[] = [];
  const { repo, token, tip } = await pushHistory('gate_wide_roots', async (main) => (objects = await wideRoots(main, 700, 900)));
  const { timing } = await clone(repo, token, [`want ${tip}`, 'filter blob:none', 'done']);
  const trees = frames(objects.filter((o) => o.kind !== 'blob'));
  console.log(`partial clone, wide roots (${mib(trees)} of trees): ${JSON.stringify(timing)}`);
  // A read per tree bundle, a second reading it whole, and a few for the levels.
  expect(timing.walk_reads).toBeLessThanOrEqual(2 * spanned(trees) + LEVELS);
  expect(timing.walk_read).toBeLessThanOrEqual(3 * (trees / 1048576) + 1.1);
});

/** `commits` commits on `parent` under a root of `dirs` unchanging directories and d/e/f/,
 * each commit rewriting d/e/f/f.txt: a wide root and three small trees per commit (four
 * walk rounds a wave), newest first. */
async function deepWide(parent: string, commits: number, dirs: number) {
  const objects: Raw[] = [];
  const file = await blob('still\n');
  const still = await tree([['100644', 'f.txt', file.id]]);
  objects.push(still, file);
  const names = Array.from({ length: dirs }, (_, d) => ['40000', `c${String(d).padStart(4, '0')}`, still.id] as [string, string, string]);
  for (let i = 0; i < commits; i++) {
    const content = await blob(`version ${i}\n`);
    const f = await tree([['100644', 'f.txt', content.id]]);
    const e = await tree([['40000', 'f', f.id]]);
    const d = await tree([['40000', 'e', e.id]]);
    const root = await tree([...names, ['40000', 'd', d.id]]);
    const commit = await commitObject(root.id, parent, i);
    objects.unshift(commit, root, d, e, f, content);
    parent = commit.id;
  }
  return objects;
}

it('a partial clone whose trees outgrow the walk memory reads each tree bundle about once', async () => {
  // 2,000 roots of 300 entries (about 18 MiB of trees) in 8 waves of commits, the walk
  // keeping 6 MiB of what it read: as svelte (150 MiB of trees, 45 waves, 32 MiB kept),
  // each wave's rounds need trees its first round's ranges held. Before the walk let its
  // oldest trees go, it kept the first 6 MiB and read the ranges again every round.
  let objects: Raw[] = [];
  const { repo, token, tip } = await pushHistory('gate_deep_wide', async (main) => (objects = await deepWide(main, 2000, 300)));
  const kept = SEEN.bytes;
  SEEN.bytes = 6 * 1048576;
  try {
    const { timing } = await clone(repo, token, [`want ${tip}`, 'filter blob:none', 'done']);
    const trees = frames(objects.filter((o) => o.kind !== 'blob'));
    console.log(`partial clone, deep wide roots, 6 MiB kept (${mib(trees)} of trees): ${JSON.stringify(timing)}`);
    // Both passes read each wave's ranges about once.
    expect(timing.walk_read).toBeLessThanOrEqual(3 * (trees / 1048576) + 1.1);
  } finally {
    SEEN.bytes = kept;
  }
});

// Known-failing. Blame reads its versions with the 1 MiB gap a clone bridges, so it reads
// the files between them: log.txt's 12 versions (~1 KiB) cost 1.26 MiB in 2 reads, its 60
// (~11 KiB) 6.93 MiB in 3, nearly every file byte pushed. Target: within the bound.
it('blame reads the versions of its file, not the history around them', async () => {
  const bounded: boolean[] = [];
  for (const commits of [12, 60]) {
    const { cookie, repo, history } = await pushed(`gate_blame_${commits}`, commits);
    let versions: unknown;
    const read = await objectReads(repo, async () => {
      versions = (await api(`/repos/${repo}/blame?path=log.txt`, { cookie }, {})).body.versions;
    });
    expect(versions).toBe(commits);
    bounded.push(within(`blame log.txt, ${commits} commits`, read, frames(history.logs)));
  }
  expect(bounded).toEqual([true, true]);
});

it('blame reads small versions six at a time, not three', async () => {
  const { cookie, repo } = await pushed('gate_blame_width', 60);
  let open = 0;
  let most = 0;
  const get = scoped.OBJECTS.get.bind(scoped.OBJECTS);
  const spy = vi.spyOn(scoped.OBJECTS, 'get').mockImplementation((async (key: string, options?: R2GetOptions) => {
    if (!key.includes('/bundles/')) return get(key, options as any);
    open++;
    most = Math.max(most, open);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await get(key, options as any);
    } finally {
      open--;
    }
  }) as any);
  try {
    expect((await api(`/repos/${repo}/blame?path=log.txt`, { cookie }, {})).body.versions).toBe(60);
  } finally {
    spy.mockRestore();
  }
  expect(most).toBeGreaterThanOrEqual(6);
});

it('search reads the head, not the history', async () => {
  for (const commits of [12, 60]) {
    const { cookie, repo, history } = await pushed(`gate_search_${commits}`, commits);
    const query = `s1.txt version ${commits - 3}`;
    let paths: unknown;
    // The first search indexes the head (every file), a second reads only candidates.
    const cold = await objectReads(repo, async () => {
      paths = (await api(`/repos/${repo}/search?q=${encodeURIComponent(query)}`, { cookie }, {})).body.results.map((r: { path: string }) => r.path);
    });
    expect(paths).toEqual(['d/e/f/s1.txt']);
    expect(within(`search cold, ${commits} commits`, cold, frames(history.head))).toBe(true);
    const candidate = history.head.filter((o) => o.kind === 'blob' && new TextDecoder().decode(o.data).includes(query));
    const warm = await objectReads(repo, () => api(`/repos/${repo}/search?q=${encodeURIComponent(query)}`, { cookie }, {}));
    expect(within(`search warm, ${commits} commits`, warm, frames(candidate))).toBe(true);
  }
});
