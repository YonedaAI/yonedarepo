// Complexity gates: what a read costs in R2 bundle bytes must scale with what the request
// needs, not with the repository's history. Each gate pushes a synthetic history in one
// push (bundles on), reads it once in a fresh isolate, and compares the bytes R2 returned
// for the repository's bundles (ranged reads count their range) with the frames (25-byte
// header + content) of the objects the request needed. Counts are of R2 reads in local
// workerd. Gates marked `it.fails` are known-failing: each names today's measured ratio and
// its target, and starts passing (so failing as `it.fails`) once a fix meets the target.
import { expect, it } from 'vitest';
import { blob, commitObject, fetchV2, objectReads, pushHistory, type Raw, sorted, tree } from './pushed-history';
import { api, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

/** Bytes read per byte wanted that a gate allows, plus one 64 KiB gap bridged (the
 * ranged-read gap for scattered reads), so a request wanting a few KiB is not held to 2x. */
const SLACK = 2;
const ALLOWANCE = 64 * 1024;
const frames = (objects: Raw[]) => objects.reduce((n, o) => n + 25 + o.data.length, 0);
const mib = (n: number) => `${(n / 1048576).toFixed(2)}MiB`;

type History = { objects: Raw[]; head: Raw[]; logs: Raw[] };

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

it('a partial clone reads its commits and trees, never the files between them', async () => {
  for (const commits of [12, 60]) {
    const { repo, token, tip, history } = await pushed(`gate_partial_${commits}`, commits);
    const wanted = frames(history.objects.filter((o) => o.kind !== 'blob'));
    let count: unknown;
    const read = await objectReads(repo, async () => (count = await fetchV2(repo, token, [`want ${tip}`, 'filter blob:none', 'done'])));
    // The pushed commits and trees, and the seed commit and its tree.
    expect(count).toBe(history.objects.length - commits * 2 + 2);
    expect(within(`partial clone, ${commits} commits`, read, wanted)).toBe(true);
  }
});

it('a full clone reads each bundled byte about once', async () => {
  for (const commits of [12, 60]) {
    const { repo, token, tip, history } = await pushed(`gate_full_${commits}`, commits);
    const wanted = frames(history.objects);
    let count: unknown;
    const read = await objectReads(repo, async () => (count = await fetchV2(repo, token, [`want ${tip}`, 'done'])));
    // The pushed objects and the seed commit's tree, file and commit.
    expect(count).toBe(history.objects.length + 3);
    expect(within(`full clone, ${commits} commits`, read, wanted)).toBe(true);
  }
});

// Known-failing. Blame reads its versions with the 1 MiB gap a clone bridges, so it reads
// the files between them: log.txt's 12 versions (~1 KiB) cost 1.26 MiB in 2 reads, its 60
// (~11 KiB) 6.93 MiB in 3, nearly every file byte pushed. Target: within the bound.
it.fails('blame reads the versions of its file, not the history around them', async () => {
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
