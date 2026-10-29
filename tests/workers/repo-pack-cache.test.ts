// A full clone served from a stored pack (PACK_CACHE=on). A clone asks for every ref tip
// and has nothing: its pack depends on its wants alone, so the first one is stored while
// it streams and later ones stream that object, with no bundle reads, deltas or zlib.
// Fetches with haves, filters or depth are built as before. Counts are of R2 reads in
// local workerd.
import { expect, it, vi } from 'vitest';
import { isolateLocations } from '../../cloudflare/worker/repo-bundles';
import { compute } from '../../cloudflare/worker/repo-compute';
import { PART, PackWriter } from '../../cloudflare/worker/repo-pack-cache';
import { fromBase64, toBase64 } from '../../cloudflare/worker/repo-objects';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { isolateTrees } from '../../cloudflare/worker/repo-tree-memo';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, PUSH_BUNDLES: 'on', PACK_CACHE: 'on' } as unknown as Env;
type Raw = { id: string; kind: 'commit' | 'tree' | 'blob'; data: Uint8Array };
const text = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const binary = (id: string) => (id.match(/../g) ?? []).map((h) => Number.parseInt(h, 16));

async function object(kind: Raw['kind'], data: Uint8Array): Promise<Raw> {
  const whole = new Uint8Array([...text.encode(`${kind} ${data.length}\0`), ...data]);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', whole))), kind, data };
}

/** `commits` commits on `parent`, each adding a file of about 600 KB of distinct text
 * (a pack of a few MiB) under d/. */
async function history(parent: string, commits: number, salt = '') {
  const objects: Raw[] = [];
  const files: [string, string, string][] = [];
  for (let i = 0; i < commits; i++) {
    const lines = Array.from({ length: 12_000 }, (_, n) => `${salt}line ${n} of file ${i}: ${(n * 7919 + i) % 100003}\n`);
    const blob = await object('blob', text.encode(lines.join('')));
    files.push(['100644', `n${i}.txt`, blob.id]);
    const d = await object('tree', new Uint8Array(files.flatMap(([mode, name, id]) => [...text.encode(`${mode} ${name}\0`), ...binary(id)])));
    const root = await object('tree', new Uint8Array([...text.encode('40000 d\0'), ...binary(d.id)]));
    const who = `${author.name} <${author.email}> ${1700000000 + i} +0000`;
    const commit = await object('commit', text.encode(`tree ${root.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\n${salt}step ${i}\n`));
    objects.unshift(commit, root, d, blob);
    parent = commit.id;
  }
  return objects;
}

async function request(repo: string, token: string, service: string, body: BodyInit, headers = {}) {
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/${service}`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}`, ...headers },
      body,
    }),
    on,
  );
  return new Uint8Array(await response.arrayBuffer());
}

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

/** The pack a v2 fetch answers (side-band data joined), or the answer when it has none. */
async function fetchV2(repo: string, token: string, args: string[]) {
  const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;
  const bytes = await request(repo, token, 'git-upload-pack', body, { 'git-protocol': 'version=2' });
  const at = new TextDecoder('latin1').decode(bytes).indexOf('packfile\n');
  if (at < 0) return new TextDecoder().decode(bytes);
  const parts: number[] = [];
  for (let i = at + 'packfile\n'.length; i + 4 <= bytes.length; ) {
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(i, i + 4)), 16);
    if (length === 0) break;
    if (bytes[i + 4] === 1) parts.push(...bytes.subarray(i + 5, i + length));
    i += length;
  }
  return new Uint8Array(parts);
}

/** R2 reads while `run` runs in a fresh isolate: of this repository's bundles and of stored
 * packs. */
async function reads(repo: string, run: () => Promise<unknown>) {
  isolateLocations.clear();
  isolateTrees.clear();
  const gets = vi.spyOn(scoped.OBJECTS, 'get');
  try {
    await run();
    const keys = gets.mock.calls.map(([key]) => String(key));
    return {
      bundles: keys.filter((k) => k.startsWith(`platform/v1/${repo}/bundles/`)).length,
      packs: keys.filter((k) => k.startsWith(`derived/v1/${repo}/packs/`)).length,
    };
  } finally {
    gets.mockRestore();
  }
}

const count = (pack: Uint8Array | string) =>
  typeof pack === 'string' ? pack : new DataView(pack.buffer, pack.byteOffset + 8, 4).getUint32(0);

it('serves a full clone from the pack the first one stored', async () => {
  const cookie = await signup('pack_cache');
  const created = await api('/repos', { cookie }, { body: { name: 'pack-cache', policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, on);
  const repo = created.body.id as string;
  const { token } = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, on)).body;
  const push = async (old: string, objects: Raw[]) => {
    const { push_b64 } = compute({
      op: 'branch_push',
      refname: 'refs/heads/main',
      old,
      new: objects[0].id,
      objects: objects.map((o) => ({ id: o.id, kind: o.kind, data_b64: toBase64(o.data) })),
    });
    const pushed = await request(repo, token, 'git-receive-pack', fromBase64(push_b64));
    expect(new TextDecoder().decode(pushed)).toContain('ok refs/heads/main');
  };
  const main = (await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main'] as string;
  const objects = await history(main, 6);
  const tip = objects[0].id;
  await push(main, objects);

  // The first clone builds the pack from the bundles and stores it.
  let first: Uint8Array | string = '';
  const built = await reads(repo, async () => (first = await fetchV2(repo, token, [`want ${tip}`, 'done'])));
  expect(count(first)).toBe(1 + 6 * 4 + 2);
  expect(built.bundles).toBeGreaterThan(0);
  const stored = await bindings.OBJECTS.list({ prefix: `derived/v1/${repo}/packs/` });
  expect(stored.objects.some((o) => o.key.endsWith('.pack'))).toBe(true);

  // The next one streams that pack: the same bytes, no bundle read.
  let second: Uint8Array | string = '';
  const served = await reads(repo, async () => (second = await fetchV2(repo, token, [`want ${tip}`, 'done'])));
  expect(served).toEqual({ bundles: 0, packs: 1 });
  expect(second).toEqual(first);
  // Version 0 clones with the same wants share it.
  const v0 = await reads(repo, () => request(repo, token, 'git-upload-pack', `${pkt(`want ${tip} side-band-64k\n`)}0000${pkt('done\n')}`));
  expect(v0).toEqual({ bundles: 0, packs: 1 });

  // A fetch with haves, a partial clone or a shallow one is built for what it asks.
  const partial = await reads(repo, async () => expect(count(await fetchV2(repo, token, [`want ${tip}`, 'filter blob:none', 'done']))).toBe(2 + 6 * 3));
  expect(partial.packs).toBe(0);
  const shallow = await reads(repo, () => fetchV2(repo, token, [`want ${tip}`, 'deepen 1', 'done']));
  expect(shallow.packs).toBe(0);
  const incremental = await reads(repo, async () => expect(count(await fetchV2(repo, token, [`want ${tip}`, `have ${objects[4].id}`, 'done']))).toBe(4));
  expect(incremental.packs).toBe(0);

  // A push moves the tip: a clone of it builds and stores its own pack.
  const more = await history(tip, 1, 'later ');
  await push(tip, more);
  const after = await reads(repo, async () => expect(count(await fetchV2(repo, token, [`want ${more[0].id}`, 'done']))).toBe(3 + 7 * 4));
  expect(after.bundles).toBeGreaterThan(0);
});

const digest = async (bytes: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

it('stores a pack of several parts, nothing when aborted, and keeps the four most recent', async () => {
  const at = (name: string) => `derived/v1/rpackwriter/packs/v1/${name}.pack`;
  const write = async (key: string, size: number) => {
    const writer = new PackWriter(scoped, 'rpackwriter', key);
    const data = new Uint8Array(size).map((_, i) => (i * 31 + size) % 251);
    for (let i = 0; i < data.length; i += 65_515) await writer.add(data.subarray(i, i + 65_515));
    return { writer, data };
  };
  const big = await write(at('big'), PART * 2 + 12_345);
  expect(await bindings.OBJECTS.head(at('big'))).toBeNull();
  expect(await big.writer.finish()).toBe(true);
  const stored = new Uint8Array(await ((await bindings.OBJECTS.get(at('big'))) as R2ObjectBody).arrayBuffer());
  expect([stored.length, await digest(stored)]).toEqual([big.data.length, await digest(big.data)]);

  const dropped = await write(at('dropped'), PART + 1);
  await dropped.writer.abort();
  expect(await bindings.OBJECTS.head(at('dropped'))).toBeNull();
  // A small pack is not worth keeping.
  expect(await (await write(at('small'), 1_000)).writer.finish()).toBe(false);
  expect(await bindings.OBJECTS.head(at('small'))).toBeNull();

  for (const name of ['p1', 'p2', 'p3', 'p4']) await (await write(at(name), 300_000)).writer.finish();
  const kept = (await bindings.OBJECTS.list({ prefix: 'derived/v1/rpackwriter/packs/v1/' })).objects.map((o) => o.key);
  expect(kept.filter((k) => k.endsWith('.pack')).sort()).toEqual(['p1', 'p2', 'p3', 'p4'].map(at));
});
