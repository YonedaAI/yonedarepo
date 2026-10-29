// What a clone of a pushed history costs in bundle reads. A fetch's walk reads trees a
// directory level per round across every commit, and a partial clone reads every commit:
// when a push's bundles interleave those with its files, each round is a ranged read per
// commit; laid out commits first, then trees, then files, a round is a read or two.
// Blame and search read a pushed history's files from its bundles in bulk too. Counts are
// of R2 reads and Durable Object commands in local workerd.
import { expect, it } from 'vitest';
import { isolateLocations } from '../../cloudflare/worker/repo-bundles';
import { isolateTrees } from '../../cloudflare/worker/repo-tree-memo';
import { blob, commitObject, fetchV2, objectReads, on, pkt, pushHistory, type Raw, request, sorted, tree } from './pushed-history';
import { api, bindings, countingOps, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

/** `commits` commits on `parent`, each adding one file of about 140 KB (more than the gap
 * bundle reads bridge; together more than a push stages) under d/e/f/ and listing it in
 * log.txt: four new trees and two files per commit, newest first. */
async function history(parent: string, commits: number) {
  const objects: Raw[] = [];
  const files: [string, string, string][] = [];
  for (let i = 0; i < commits; i++) {
    const added = await blob(`${`file ${i} `.repeat(20_000)}\n`);
    files.push(['100644', `n${i}.txt`, added.id]);
    const f = await tree(sorted(files));
    const e = await tree([['40000', 'f', f.id]]);
    const d = await tree([['40000', 'e', e.id]]);
    const log = await blob(`${files.map(([, name]) => name).join('\n')}\n`);
    const root = await tree([
      ['40000', 'd', d.id],
      ['100644', 'log.txt', log.id],
    ]);
    const commit = await commitObject(root.id, parent, i);
    objects.unshift(commit, root, d, e, f, added, log);
    parent = commit.id;
  }
  return objects;
}

/** R2 reads of this repository's bundles while `run` runs, in a fresh isolate. */
async function bundleReads(repo: string, run: () => Promise<unknown>) {
  return (await objectReads(repo, run)).reads;
}

/** A new repository with `commits` commits of `history` pushed to main in one push. */
const pushedHistory = (name: string, commits: number) => pushHistory(name, (main) => history(main, commits));

it('keeps the commits and trees of a large push in bundles of their own', async () => {
  // 60 commits: 420 objects, more than a push stages.
  const { repo } = await pushedHistory('history_split', 60);
  const listed = await bindings.OBJECTS.list({ prefix: `platform/v1/${repo}/bundles/` });
  expect(listed.objects.length).toBeGreaterThan(1);
  const kinds: string[] = [];
  for (const { key } of listed.objects) {
    const bytes = new Uint8Array(await ((await bindings.OBJECTS.get(key)) as R2ObjectBody).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const held = new Set<number>();
    for (let at = 0; at < bytes.length; at += 25 + view.getUint32(at + 21)) held.add(bytes[at]);
    kinds.push([...held].sort().join(''));
  }
  // Commits (1) and trees (2) apart from files (3).
  expect(kinds.every((k) => k === '3' || !k.includes('3'))).toBe(true);
  expect(kinds).toContain('3');
});

it('clones a pushed history in a few bundle reads per directory level', async () => {
  const { cookie, repo, token, tip } = await pushedHistory('history_reads', 8);

  // Everything: 9 commits, 1 + 8 * 4 trees, 1 + 8 * 2 files. Five walk rounds (a directory
  // level each, then the last) and the commits and files: a read or two each.
  let count: unknown;
  const full = await bundleReads(repo, async () => (count = await fetchV2(repo, token, [`want ${tip}`, 'done'])));
  expect(count).toBe(59);
  expect(full).toBeGreaterThan(0);
  expect(full).toBeLessThanOrEqual(8);
  // Asked for timings, the pack ends with them; log.txt's later versions went as deltas.
  const timed = await request(repo, token, 'git-upload-pack', `${pkt('command=fetch\n')}0001${pkt(`want ${tip}\n`)}${pkt('done\n')}0000`, {
    'git-protocol': 'version=2',
    'x-yoneda-timing': '1',
  });
  const line = /yoneda-timing (.*)\n/.exec(new TextDecoder('latin1').decode(timed))?.[1] ?? '';
  expect(line).toMatch(/entries=59 /);
  // Walk and pack reads each report what they read against what they wanted.
  expect(line).toMatch(/walk_reads=\d+ walk_read=[\d.]+MiB walk_wanted=[\d.]+MiB walk_bundles=1 walk_span=/);
  expect(line).toMatch(/ reads=\d+ read=[\d.]+MiB wanted=[\d.]+MiB bundles=1 span=/);
  expect(Number(/deltas=(\d+)/.exec(line)?.[1])).toBeGreaterThanOrEqual(4);
  // A partial clone: the same walk, and the commits (no files).
  const partial = await bundleReads(repo, async () => (count = await fetchV2(repo, token, [`want ${tip}`, 'filter blob:none', 'done'])));
  expect(count).toBe(42);
  expect(partial).toBeLessThanOrEqual(7);

  // Blame and search in a fresh isolate: the repository's status says it holds bundles, so
  // every version and candidate file is read from them in bulk, none through a staged read.
  isolateLocations.clear();
  isolateTrees.clear();
  const { env, take } = countingOps(on);
  const blamed = (await api(`/repos/${repo}/blame?path=log.txt`, { cookie }, {}, env)).body;
  expect(blamed.versions).toBe(8);
  expect(blamed.lines).toHaveLength(8);
  const found = (await api(`/repos/${repo}/search?q=file%207`, { cookie }, {}, env)).body;
  expect(found.results.map((r: { path: string }) => r.path)).toEqual(['d/e/f/n7.txt']);
  const ops = take();
  expect(ops.repo_staged_objects ?? 0).toBe(0);
});
