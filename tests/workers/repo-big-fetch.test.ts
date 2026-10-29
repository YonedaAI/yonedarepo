// A fetch is no longer capped at 40,000 objects: a synthetic history of 200,000 objects
// (1,000 commits of 197 files each, pushed in five pushes) clones full and partial, the
// pack streamed in waves of commits, with this isolate's Wasm memory, the R2 reads and the
// authority calls recorded. Packs are built here in JavaScript (zlib stored blocks).
import { expect, it, vi } from 'vitest';
import { isolateLocations } from '../../cloudflare/worker/repo-bundles';
import { wasmMemoryBytes } from '../../cloudflare/worker/repo-git-sessions';
import { isolateTrees } from '../../cloudflare/worker/repo-tree-memo';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, countingOps, file, scoped, signup, usePlatformFixture } from './repo-fixture';
import { git, hex, join, type Obj, object, pack, pkt, text, tree } from './synthetic-pack';

usePlatformFixture();

const on = { ...scoped, PUSH_BUNDLES: 'on' } as unknown as Env;
const MiB = 1024 * 1024;
/** A v2 fetch's pack (side-band 1 joined) and its error lines (side-band 3). */
async function fetchV2(repo: string, token: string, args: string[], target: Env) {
  const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;
  const bytes = await git(repo, token, 'git-upload-pack', body, target, { 'git-protocol': 'version=2' });
  const from = new TextDecoder('latin1').decode(bytes).indexOf('packfile\n');
  const packs: Uint8Array[] = [];
  const errors: string[] = [];
  for (let i = from + 'packfile\n'.length; from >= 0 && i + 4 <= bytes.length; ) {
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(i, i + 4)), 16);
    if (!length) break;
    if (bytes[i + 4] === 1) packs.push(bytes.subarray(i + 5, i + length));
    if (bytes[i + 4] === 3) errors.push(new TextDecoder().decode(bytes.subarray(i + 5, i + length)));
    i += length;
  }
  return { pack: join(packs), errors, raw: from < 0 ? new TextDecoder().decode(bytes) : '' };
}

const count = (pack: Uint8Array) => new DataView(pack.buffer, pack.byteOffset + 8, 4).getUint32(0);
async function trailerHolds(pack: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', pack.subarray(0, pack.length - 20)));
  return hex(digest) === hex(pack.subarray(pack.length - 20));
}

const COMMITS = 1000;
const FILES = 197;
const PUSHES = 5;

it('clones a 200,000-object history full and partial, streamed in waves', { timeout: 900_000 }, async () => {
  const cookie = await signup('big_fetch');
  const created = await api('/repos', { cookie }, { body: { name: 'big-fetch', policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, on);
  const repo = created.body.id as string;
  const { token } = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, on)).body;
  let parent = (await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main'] as string;
  const seedTree = (await api(`/repos/${repo}/tree?commit=${parent}`, { cookie }, {}, on)).body.entries as { name: string; id: string }[];
  const root: [string, string, string][] = seedTree.map((e) => ['100644', e.name, e.id]);
  // In local workerd the authority's Durable Objects share this isolate's Wasm memory, so
  // the pushes' lines below count both.
  console.log(`big fetch start: wasm ${(wasmMemoryBytes() / MiB).toFixed(0)} MiB`);

  // Each commit adds c<i>/ holding FILES new files: itself, 2 trees and FILES blobs.
  for (let p = 0; p < PUSHES; p++) {
    const objects: Obj[] = [];
    const old = parent;
    for (let i = p * (COMMITS / PUSHES); i < (p + 1) * (COMMITS / PUSHES); i++) {
      const blobs = await Promise.all(Array.from({ length: FILES }, (_, k) => object('blob', text.encode(`commit ${i} file ${k}\n`))));
      const names = blobs.map((b, k) => ['100644', `f${String(k).padStart(3, '0')}`, b.id] as [string, string, string]);
      const dir = await tree(names);
      root.push(['40000', `c${String(i).padStart(4, '0')}`, dir.id]);
      const top = await tree(root);
      const who = `${author.name} <${author.email}> ${1700000000 + i} +0000`;
      const commit = await object('commit', text.encode(`tree ${top.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\nc${i}\n`));
      objects.push(commit, top, dir, ...blobs);
      parent = commit.id;
    }
    const head = text.encode(`${pkt(`${old} ${parent} refs/heads/main\0report-status\n`)}0000`);
    const report = new TextDecoder().decode(await git(repo, token, 'git-receive-pack', join([head, await pack(objects)]), on));
    expect(report, `push ${p + 1}`).toContain('ok refs/heads/main');
    console.log(`big fetch push ${p + 1}: wasm ${(wasmMemoryBytes() / MiB).toFixed(0)} MiB`);
  }
  const total = COMMITS * (FILES + 3) + 3;
  expect(total).toBeGreaterThanOrEqual(200_000);

  const measured = async (args: string[]) => {
    isolateLocations.clear();
    isolateTrees.clear();
    const { env, take } = countingOps(on);
    const gets = vi.spyOn(scoped.OBJECTS, 'get');
    const memory = wasmMemoryBytes();
    const started = performance.now();
    try {
      const fetched = await fetchV2(repo, token, args, env);
      const ops = take();
      const r2 = gets.mock.calls.length;
      return { ...fetched, ms: Math.round(performance.now() - started), r2, ops, memory, grown: wasmMemoryBytes() - memory };
    } finally {
      gets.mockRestore();
    }
  };
  const full = await measured([`want ${parent}`, 'done']);
  expect(full.errors).toEqual([]);
  expect(full.raw).toBe('');
  expect(count(full.pack)).toBe(total);
  expect(await trailerHolds(full.pack)).toBe(true);
  const partial = await measured([`want ${parent}`, 'filter blob:none', 'done']);
  expect(partial.errors).toEqual([]);
  expect(count(partial.pack)).toBe(COMMITS * 3 + 2);
  expect(await trailerHolds(partial.pack)).toBe(true);
  for (const [name, m] of [['full', full], ['partial', partial]] as const)
    console.log(
      `big fetch ${name}: ${count(m.pack)} objects, ${(m.pack.length / MiB).toFixed(1)} MiB in ${m.ms} ms; R2 gets ${m.r2}; authority ${JSON.stringify(m.ops)}; wasm ${(m.memory / MiB).toFixed(0)} MiB, grew ${(m.grown / MiB).toFixed(1)} MiB`,
    );
  // Memory is the wave's, not the history's.
  expect(full.grown).toBeLessThan(64 * MiB);
  // Walks bridge gaps between trees and commits (each read is a round trip): measured 440
  // and 46 R2 reads; bounding their waste as blob reads do made them 662 and 268.
  expect(full.r2).toBeLessThanOrEqual(480);
  expect(partial.r2).toBeLessThanOrEqual(60);
});
