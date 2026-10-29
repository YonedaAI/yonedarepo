// Large files (up to GitHub's 100 MiB per file, warned over 50 MiB) push, clone and read
// back byte for byte without being held whole: a 90 MiB synthetic file streams into R2 as
// it arrives and back out in packs and downloads, while this isolate's Wasm memory grows by
// less than the file. The pack is built here in JavaScript, never in Rust compute.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { wasmMemoryBytes } from '../../cloudflare/worker/repo-git-sessions';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, PUSH_BUNDLES: 'on' } as unknown as Env;
const MiB = 1024 * 1024;
const text = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const binary = (id: string) => Uint8Array.from((id.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)));
const sha1 = async (parts: Uint8Array[]) => new Uint8Array(await crypto.subtle.digest('SHA-1', join(parts)));

function join(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `n` bytes that do not compress (xorshift), so the pack is about as large as the file. */
function noise(n: number) {
  const out = new Uint8Array(n);
  const words = new Uint32Array(out.buffer, 0, n >> 2);
  let state = 0x9e3779b9;
  for (let i = 0; i < words.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    words[i] = state >>> 0;
  }
  return out;
}

async function zlib(data: Uint8Array) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(data: Uint8Array) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

type Obj = { kind: 'commit' | 'tree' | 'blob'; data: Uint8Array; id: string };
const CODES = { commit: 1, tree: 2, blob: 3 };
async function object(kind: Obj['kind'], data: Uint8Array): Promise<Obj> {
  return { kind, data, id: hex(await sha1([text.encode(`${kind} ${data.length}\0`), data])) };
}

/** A pack of `objects` (whole entries), built here. */
async function pack(objects: Obj[]) {
  const parts: Uint8Array[] = [text.encode('PACK'), Uint8Array.of(0, 0, 0, 2), Uint8Array.of(0, 0, 0, objects.length)];
  for (const o of objects) {
    let size = o.data.length;
    const head = [(CODES[o.kind] << 4) | (size & 15)];
    size = Math.floor(size / 16);
    while (size > 0) {
      head[head.length - 1] |= 0x80;
      head.push(size & 0x7f);
      size = Math.floor(size / 128);
    }
    parts.push(Uint8Array.from(head), await zlib(o.data));
  }
  parts.push(await sha1(parts));
  return join(parts);
}

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

async function git(repo: string, token: string, service: string, body: BodyInit, headers = {}) {
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

/** Side-band channel `band` of a v2 fetch answer after its `packfile` line, joined. */
function band(bytes: Uint8Array, channel: number, from = 'packfile\n') {
  const at = new TextDecoder('latin1').decode(bytes).indexOf(from);
  const parts: Uint8Array[] = [];
  for (let i = at < 0 ? 0 : at + from.length; i + 4 <= bytes.length; ) {
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(i, i + 4)), 16);
    if (!length) {
      i += 4;
      continue;
    }
    if (bytes[i + 4] === channel) parts.push(bytes.subarray(i + 5, i + length));
    i += length;
  }
  return join(parts);
}

async function fetchV2(repo: string, token: string, args: string[]) {
  const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;
  return band(await git(repo, token, 'git-upload-pack', body, { 'git-protocol': 'version=2' }), 1);
}

/** A repository with a token, and main's head. */
async function repository(name: string, cookie: string) {
  const created = await api('/repos', { cookie }, { body: { name, policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, on);
  const repo = created.body.id as string;
  const { token } = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, on)).body;
  const main = (await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main'] as string;
  return { repo, token, main };
}

/** Pushes `packed` moving `ref` from `old` to `tip`; answers the report text. */
async function push(repo: string, token: string, old: string, tip: string, packed: Uint8Array, ref = 'refs/heads/main') {
  const head = text.encode(`${pkt(`${old} ${tip} ${ref}\0report-status side-band-64k\n`)}0000`);
  const answer = await git(repo, token, 'git-receive-pack', join([head, packed]));
  return new TextDecoder().decode(answer);
}

it('pushes, clones and reads back a 90 MiB file without holding it', { timeout: 300_000 }, async () => {
  const cookie = await signup('large_files');
  const { repo, token, main } = await repository('large-files', cookie);
  const big = await object('blob', noise(90 * MiB));
  const small = await object('blob', text.encode('small\n'));
  const root = await object('tree', join([text.encode('100644 big.bin\0'), binary(big.id), text.encode('100644 small.txt\0'), binary(small.id)]));
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = await object('commit', text.encode(`tree ${root.id}\nparent ${main}\nauthor ${who}\ncommitter ${who}\n\nbig file\n`));
  const packed = await pack([commit, root, small, big]);

  const memory = wasmMemoryBytes();
  const report = await push(repo, token, main, commit.id, packed);
  expect(report).toContain('ok refs/heads/main');
  expect(report).toContain('warning: File big.bin is 90.00 MB; this is larger than the recommended maximum file size of 50.00 MB');
  // Stored once, as its own raw object; nothing left at the upload's temporary key.
  expect((await bindings.OBJECTS.head(`platform/v1/${repo}/git/${big.id}`))?.size).toBe(90 * MiB);
  expect((await bindings.OBJECTS.list({ prefix: `platform/v1/${repo}/incoming/` })).objects).toEqual([]);

  // A full clone's pack carries it: pushed into a second repository, which verifies every
  // object's id from its bytes as it arrives.
  const full = await fetchV2(repo, token, [`want ${commit.id}`, 'done']);
  expect(full.length).toBeGreaterThan(90 * MiB);
  const copy = await repository('large-files-copy', cookie);
  expect(await push(copy.repo, copy.token, '0'.repeat(40), commit.id, full, 'refs/heads/copy')).toContain('ok refs/heads/copy');
  expect((await bindings.OBJECTS.head(`platform/v1/${copy.repo}/git/${big.id}`))?.size).toBe(90 * MiB);

  // A partial clone's checkout fetches it lazily by id: a pack of that one file.
  const partial = await fetchV2(repo, token, [`want ${commit.id}`, 'filter blob:none', 'done']);
  expect(new DataView(partial.buffer, partial.byteOffset + 8, 4).getUint32(0)).toBe(4);
  const lazy = await fetchV2(repo, token, [`want ${big.id}`, 'no-progress', 'done']);
  expect(new DataView(lazy.buffer, lazy.byteOffset + 8, 4).getUint32(0)).toBe(1);
  let header = 12;
  while (lazy[header] & 0x80) header++;
  const content = await inflate(lazy.subarray(header + 1, lazy.length - 20));
  expect(hex(await sha1([text.encode(`blob ${content.length}\0`), content]))).toBe(big.id);

  // yoneda:: clones page objects with `large`: a stub, then the download streams.
  const page = await api(`/repos/${repo}/objects`, { cookie }, { body: { objects: [{ id: big.id, kind: 'blob' }], large: true } }, on);
  expect(page.body.objects).toEqual([{ id: big.id, kind: 'blob', size: 90 * MiB, large: true }]);
  const download = await platformFetch(new Request(`https://yoneda/api/v1/repos/${repo}/objects/${big.id}`, { headers: { cookie } }), on);
  expect(download.headers.get('content-length')).toBe(String(90 * MiB));
  const downloaded = new Uint8Array(await download.arrayBuffer());
  expect(hex(await sha1([text.encode(`blob ${downloaded.length}\0`), downloaded]))).toBe(big.id);
  // A JSON read refuses it, pointing at the download; search lists it unread.
  const read = await api(`/repos/${repo}/blob?path=big.bin`, { cookie }, {}, on);
  expect(read.body.error).toMatchObject({ code: 'TOO_LARGE' });
  expect(read.body.error.message).toContain(`/objects/${big.id}`);
  const found = await api(`/repos/${repo}/search?q=small`, { cookie }, {}, on);
  expect(found.body.results.map((r: { path: string }) => r.path)).toEqual(['small.txt']);

  // Pushing, cloning and reading it all grew Wasm memory by less than the file.
  const grown = wasmMemoryBytes() - memory;
  console.log(`large file: wasm memory ${(memory / MiB).toFixed(0)} MiB, grew ${(grown / MiB).toFixed(1)} MiB`);
  expect(grown).toBeLessThan(48 * MiB);
});

it('refuses a file over 100 MiB, naming the limit', { timeout: 300_000 }, async () => {
  const cookie = await signup('too_large_files');
  const { repo, token, main } = await repository('too-large', cookie);
  const big = await object('blob', new Uint8Array(101 * MiB));
  const root = await object('tree', join([text.encode('100644 huge.bin\0'), binary(big.id)]));
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = await object('commit', text.encode(`tree ${root.id}\nparent ${main}\nauthor ${who}\ncommitter ${who}\n\nhuge\n`));
  const report = await push(repo, token, main, commit.id, await pack([commit, root, big]));
  expect(report).toContain('the limit is 100 MiB per file');
  expect((await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main']).toBe(main);
});
