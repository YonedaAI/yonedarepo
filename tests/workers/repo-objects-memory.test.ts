// Memory probes for object pages (repo-object-fetch.ts): what a streamed 16 MiB page of eight
// 2 MiB blobs, and a whole pushed history fetched page by page (a full yoneda:: clone), do to
// the isolate. Wasm linear memory is read with the `memory` compute op (it only grows, so
// growth is what a request left behind for good), and so are the bytes passed into Wasm
// (`computeInput`: Wasm grows to a few times a call's input); workerd reports no JS heap figures
// (process.memoryUsage() is all zeros here), so the JS side is bounded by construction (a
// streamed page holds the batch in flight) and checked through the page's own counts.
// The blobs are pushed over Git so their reads go to the store of record (push bundles).
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { edgeDelete } from '../../cloudflare/worker/repo-cache-tiers';
import { compute, computeInput } from '../../cloudflare/worker/repo-compute';
import { fromBase64, toBase64 } from '../../cloudflare/worker/repo-objects';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, PUSH_BUNDLES: 'on' } as unknown as Env;
const text = new TextEncoder();
const MiB = 1024 * 1024;
type Raw = { id: string; kind: 'commit' | 'tree' | 'blob'; data: Uint8Array };
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const binary = (id: string) => (id.match(/../g) ?? []).map((h) => Number.parseInt(h, 16));
const wasm = () => Number(compute({ op: 'memory' }).wasm_bytes);

async function object(kind: Raw['kind'], data: Uint8Array): Promise<Raw> {
  const whole = new Uint8Array([...text.encode(`${kind} ${data.length}\0`), ...data]);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', whole))), kind, data };
}

/** `commits` versions of one file of `size` bytes (as a long history of a large file), pushed
 * one commit per push so the pushes themselves leave little Wasm memory behind; returns the
 * repository, its cookie and every version's blob id. */
async function pushed(name: string, commits: number, size: number) {
  const perCommit = 1;
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name, policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, on);
  const repo = created.body.id as string;
  const { token } = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, on)).body;
  let parent = (await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main'] as string;
  const ids: string[] = [];
  for (let c = 0; c < commits; c++) {
    const files: [string, Raw][] = [];
    for (let f = 0; f < perCommit; f++) {
      const seed = `${name}-${c}-${f}-`;
      const content = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) content[i] = (seed.charCodeAt(i % seed.length) * 31 + i * 7 + c) & 0xff;
      files.push([`f${f}.bin`, await object('blob', content)]);
    }
    const root = await object('tree', new Uint8Array(files.flatMap(([n, b]) => [...text.encode(`100644 ${n}\0`), ...binary(b.id)])));
    const who = `${author.name} <${author.email}> 1700000000 +0000`;
    const commit = await object('commit', text.encode(`tree ${root.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\nround ${c}\n`));
    const { push_b64 } = compute({
      op: 'branch_push',
      refname: 'refs/heads/main',
      old: parent,
      new: commit.id,
      objects: [commit, root, ...files.map(([, b]) => b)].map((o) => ({ id: o.id, kind: o.kind, data_b64: toBase64(o.data) })),
    });
    const answer = await platformFetch(
      new Request(`https://yoneda/git/${repo}.git/git-receive-pack`, { method: 'POST', headers: { authorization: `Basic ${btoa(`git:${token}`)}` }, body: fromBase64(push_b64) }),
      on,
    );
    expect(new TextDecoder().decode(await answer.arrayBuffer())).toContain('ok refs/heads/main');
    ids.push(...files.map(([, b]) => b.id));
    parent = commit.id;
  }
  return { repo, cookie, ids };
}

/** Drops the blobs' cache-tier copies (edge and R2), so the next page reads them from the
 * store of record (the push bundles), as a cold clone on dev does. */
async function cold(repo: string, ids: string[]) {
  for (const id of ids) {
    await edgeDelete(repo, id);
    await bindings.OBJECTS.delete(`platform/v1/${repo}/objects/${id}`);
  }
}

/** One streamed POST /objects page, read to its end. */
async function page(repo: string, cookie: string, objects: { id: string; kind: string }[], after = 0) {
  const answer = await platformFetch(
    new Request(`https://yoneda/api/v1/repos/${repo}/objects`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ objects, after, large: true }),
    }),
    on,
  );
  expect(answer.status).toBe(200);
  return answer.json<any>();
}

it('a streamed 16 MiB page of eight 2 MiB blobs leaves Wasm memory where it was', async () => {
  const size = 2 * MiB - 1024;
  const { repo, cookie, ids } = await pushed('memorypage', 8, size);
  const blobs = ids.map((id) => ({ id, kind: 'blob' }));
  await page(repo, cookie, blobs.slice(0, 1)); // warm the isolate's own allocations
  const before = wasm();
  const sent = computeInput.bytes;
  for (let round = 0; round < 3; round++) {
    await cold(repo, ids);
    // About 16 MiB of base64 per page: the eight arrive over two pages, whole and in order.
    const got: string[] = [];
    for (let after: number | null = 0; after !== null; ) {
      const body = await page(repo, cookie, blobs, after);
      for (const o of body.objects) expect(fromBase64(o.data_b64).length).toBe(size);
      got.push(...body.objects.map((o: any) => o.id));
      after = body.next;
    }
    expect(got).toEqual(ids);
  }
  // No blob goes into Wasm (they are checked in JS): three cold rounds of 16 MiB pass in
  // well under a megabyte of trees, commits and bundle locations.
  const into = computeInput.bytes - sent;
  expect(into, `${into} bytes went into Wasm`).toBeLessThan(MiB);
  const grew = wasm() - before;
  expect(grew, `Wasm memory grew ${grew} bytes`).toBeLessThanOrEqual(2 * MiB);
});

it('a full fetch of a pushed history, page by page, leaves Wasm memory bounded', async () => {
  // 24 versions of a 1.5 MiB file (36 MiB of content): every blob of every version.
  const { repo, cookie, ids } = await pushed('memoryclone', 24, 1.5 * MiB);
  const blobs = ids.map((id) => ({ id, kind: 'blob' }));
  await page(repo, cookie, blobs.slice(0, 1));
  await cold(repo, ids);
  const before = wasm();
  const sent = computeInput.bytes;
  const got: string[] = [];
  let pages = 0;
  for (let after: number | null = 0; after !== null; pages++) {
    const body = await page(repo, cookie, blobs, after);
    got.push(...body.objects.map((o: any) => o.id));
    after = body.next;
  }
  expect(got).toEqual(ids);
  expect(pages).toBeGreaterThanOrEqual(3);
  const into = computeInput.bytes - sent;
  expect(into, `${into} bytes went into Wasm over ${pages} pages`).toBeLessThan(MiB);
  const grew = wasm() - before;
  expect(grew, `Wasm memory grew ${grew} bytes over ${pages} pages`).toBeLessThanOrEqual(4 * MiB);
});

it('the probe sees what a Wasm parse of a large blob costs (its sensitivity)', () => {
  // The path blobs left in 7e4362e5: a Rust parse holds about 5x the blob in Wasm memory.
  const before = wasm();
  const blob = new Uint8Array(12 * MiB).fill(7);
  const id = '0'.repeat(40);
  try {
    compute({ op: 'parse_objects', objects: [{ id, kind: 'blob', data_b64: toBase64(blob) }] });
  } catch {
    // The id does not match: refused, but only after the input was taken in.
  }
  expect(wasm() - before).toBeGreaterThan(12 * MiB);
});
