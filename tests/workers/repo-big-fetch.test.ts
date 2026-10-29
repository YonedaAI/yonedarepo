// A fetch is no longer capped at 40,000 objects: a synthetic history of 200,000 objects
// (1,000 commits of 197 files each, pushed in five pushes) clones full and partial, the
// pack streamed in waves of commits, with this isolate's Wasm memory, the R2 reads and the
// authority calls recorded. Packs are built here in JavaScript (zlib stored blocks).
import { expect, it, vi } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { isolateLocations } from '../../cloudflare/worker/repo-bundles';
import { wasmMemoryBytes } from '../../cloudflare/worker/repo-git-sessions';
import { isolateTrees } from '../../cloudflare/worker/repo-tree-memo';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, countingOps, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, PUSH_BUNDLES: 'on' } as unknown as Env;
const MiB = 1024 * 1024;
const text = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const binary = (id: string) => Uint8Array.from((id.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)));

function join(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `data` as a zlib stream of stored blocks (no compression: fast to build). */
function zlib(data: Uint8Array) {
  const parts: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  for (let at = 0; at === 0 || at < data.length; at += 65535) {
    const block = data.subarray(at, at + 65535);
    const last = at + 65535 >= data.length ? 1 : 0;
    parts.push(Uint8Array.of(last, block.length & 255, block.length >> 8, ~block.length & 255, (~block.length >> 8) & 255), block);
  }
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  parts.push(Uint8Array.of(b >> 8, b & 255, a >> 8, a & 255));
  return join(parts);
}

type Obj = { kind: 'commit' | 'tree' | 'blob'; data: Uint8Array; id: string };
const CODES = { commit: 1, tree: 2, blob: 3 };
async function object(kind: Obj['kind'], data: Uint8Array): Promise<Obj> {
  const head = text.encode(`${kind} ${data.length}\0`);
  return { kind, data, id: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', join([head, data])))) };
}
const tree = (entries: [string, string, string][]) =>
  object('tree', join(entries.flatMap(([mode, name, id]) => [text.encode(`${mode} ${name}\0`), binary(id)])));

async function pack(objects: Obj[]) {
  const n = objects.length;
  const parts: Uint8Array[] = [text.encode('PACK'), Uint8Array.of(0, 0, 0, 2, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255)];
  for (const o of objects) {
    let size = o.data.length;
    const head = [(CODES[o.kind] << 4) | (size & 15)];
    size = Math.floor(size / 16);
    while (size > 0) {
      head[head.length - 1] |= 0x80;
      head.push(size & 0x7f);
      size = Math.floor(size / 128);
    }
    parts.push(Uint8Array.from(head), zlib(o.data));
  }
  const body = join(parts);
  return join([body, new Uint8Array(await crypto.subtle.digest('SHA-1', body))]);
}

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

async function git(repo: string, token: string, service: string, body: BodyInit, target: Env, headers = {}) {
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/${service}`, { method: 'POST', headers: { authorization: `Basic ${btoa(`git:${token}`)}`, ...headers }, body }),
    target,
  );
  return new Uint8Array(await response.arrayBuffer());
}

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
});
