// Clones served from a stored pack (PACK_CACHE=on). A clone has nothing: its pack depends
// on its wants, filter and depth alone, so the first one is stored while it streams and
// later ones stream that object, with no bundle reads, deltas or zlib. Fetches with haves
// are built as before. Counts are of R2 reads in local workerd.
import { expect, it, vi } from 'vitest';
import { withWaitUntil } from '../../cloudflare/worker/background';
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

  // A partial clone is never served the full clone's pack (this one, of commits and trees
  // only, is too small to store).
  const partial = await reads(repo, async () => expect(count(await fetchV2(repo, token, [`want ${tip}`, 'filter blob:none', 'done']))).toBe(2 + 6 * 3));
  expect(partial.bundles).toBeGreaterThan(0);
  // A shallow clone and a checkout's files wanted by id (neither has anything) store packs
  // of their own, and later ones stream them.
  const fresh = [
    [[`want ${tip}`, 'deepen 1', 'done'], 1 + 2 + 6],
    [[...objects.filter((o) => o.kind === 'blob').map((o) => `want ${o.id}`), 'filter blob:none', 'done'], 6],
  ] as const;
  for (const [args, objectCount] of fresh) {
    let built: Uint8Array | string = '';
    const first = await reads(repo, async () => (built = await fetchV2(repo, token, [...args])));
    expect(count(built)).toBe(objectCount);
    expect(first.bundles).toBeGreaterThan(0);
    let again: Uint8Array | string = '';
    const hit = await reads(repo, async () => (again = await fetchV2(repo, token, [...args])));
    expect(hit).toEqual({ bundles: 0, packs: 1 });
    expect(again).toEqual(built);
  }
  // A fetch with haves is built for what it lacks.
  const incremental = await reads(repo, async () => expect(count(await fetchV2(repo, token, [`want ${tip}`, `have ${objects[4].id}`, 'done']))).toBe(4));
  expect(incremental.packs).toBe(0);

  // A push moves the tip: a clone of it builds and stores its own pack.
  const more = await history(tip, 1, 'later ');
  await push(tip, more);
  const after = await reads(repo, async () => expect(count(await fetchV2(repo, token, [`want ${more[0].id}`, 'done']))).toBe(3 + 7 * 4));
  expect(after.bundles).toBeGreaterThan(0);
});

const digest = async (bytes: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

it('stores a pack of several parts, nothing when aborted, and keeps the eight most recent', async () => {
  const at = (name: string) => `derived/v1/rpackwriter/packs/v2/${name}.pack`;
  const write = async (key: string, size: number) => {
    const writer = new PackWriter(scoped, 'rpackwriter', key);
    const data = new Uint8Array(size).map((_, i) => (i * 31 + size) % 251);
    for (let i = 0; i < data.length; i += 65_515) {
      expect(writer.offer(data.subarray(i, i + 65_515))).toBe(true);
      // R2 takes each part before the next one fills (a clone streams slower than that).
      if ((i + 65_515) % PART < 65_515) await new Promise((r) => setTimeout(r, 200));
    }
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

  const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
  for (const name of names) await (await write(at(name), 300_000)).writer.finish();
  const kept = (await bindings.OBJECTS.list({ prefix: 'derived/v1/rpackwriter/packs/v2/' })).objects.map((o) => o.key);
  expect(kept.filter((k) => k.endsWith('.pack')).sort()).toEqual(names.map(at));
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
  } finally {
    create.mockRestore();
  }
  expect(await bindings.OBJECTS.head(key)).toBeNull();
});

it('never holds a clone back on the store: a stalled store is left behind the answer', async () => {
  const cookie = await signup('pack_cache_stall');
  const created = await api('/repos', { cookie }, { body: { name: 'pack-cache-stall', policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, on);
  const repo = created.body.id as string;
  const { token } = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, on)).body;
  const main = (await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main'] as string;
  const objects = await history(main, 6);
  const { push_b64 } = compute({
    op: 'branch_push',
    refname: 'refs/heads/main',
    old: main,
    new: objects[0].id,
    objects: objects.map((o) => ({ id: o.id, kind: o.kind, data_b64: toBase64(o.data) })),
  });
  expect(new TextDecoder().decode(await request(repo, token, 'git-receive-pack', fromBase64(push_b64)))).toContain('ok refs/heads/main');
  // R2 never answers a write of a stored pack.
  const put = scoped.OBJECTS.put.bind(scoped.OBJECTS);
  const stall = vi.spyOn(scoped.OBJECTS, 'put').mockImplementation(((key: string, ...rest: unknown[]) =>
    key.includes('/packs/') ? new Promise(() => {}) : (put as any)(key, ...rest)) as any);
  const later: Promise<unknown>[] = [];
  try {
    const pack = await withWaitUntil((work) => void later.push(work), () => fetchV2(repo, token, [`want ${objects[0].id}`, 'done']));
    expect(count(pack)).toBe(1 + 6 * 4 + 2);
    expect(later).toHaveLength(1);
  } finally {
    stall.mockRestore();
  }
  expect((await bindings.OBJECTS.list({ prefix: `derived/v1/${repo}/packs/` })).objects).toEqual([]);
});
