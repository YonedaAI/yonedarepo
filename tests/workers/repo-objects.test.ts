// Batch, resumable object fetch through the tiered cache (Scion S11/S12).
import { expect, it, vi } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { DOWNLOAD_DEADLINE } from '../../cloudflare/worker/repo-object-download';
import { nextBatch, PAGE_DEADLINE } from '../../cloudflare/worker/repo-object-fetch';
import { gitObjectId, RepoObjects } from '../../cloudflare/worker/repo-objects';
import { api, author, file, misses, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

it('serves objects by id from the cache tiers and resumes across the response budget', async () => {
  const owner = { cookie: await signup('objectowner') };
  // Each over half the 16 MiB response budget once base64'd: one per page.
  const big = (fill: string) => ({ path: `${fill}.bin`, content_b64: btoa(fill.repeat(9 * 1024 * 1024)) });
  const created = await api('/repos', owner, {
    body: { name: 'objects', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n'), big('x'), big('y')], author },
  });
  const repo = `/repos/${created.body.id}`;
  const head = await api(`${repo}/commits/${created.body.commit}`, owner);
  const root = await api(`${repo}/objects`, owner, {
    body: { objects: [{ id: head.body.commit, kind: 'commit' }, { id: head.body.tree, kind: 'tree' }] },
  });
  expect(root.body.objects.map((o: any) => o.kind)).toEqual(['commit', 'tree']);
  expect(root.body.objects[0].tree).toBe(head.body.tree);
  expect(root.body.next).toBeNull();
  // Written through at commit time: served from the edge and R2 tiers, never the store.
  expect(root.body.tiers.store).toBe(0);
  expect(root.body.tiers.edge + root.body.tiers.r2).toBe(2);

  const blobs = root.body.objects[1].entries.filter((e: any) => e.type === 'blob').map((e: any) => ({ id: e.id, kind: 'blob' }));
  expect(blobs).toHaveLength(3);
  const first = await api(`${repo}/objects`, owner, { body: { objects: blobs } });
  expect(first.body.objects.length).toBeLessThan(3);
  expect(first.body.next).toBe(first.body.objects.length);
  const all = [...first.body.objects];
  for (let after = first.body.next; after !== null; ) {
    const page = await api(`${repo}/objects`, owner, { body: { objects: blobs, after } });
    all.push(...page.body.objects);
    after = page.body.next;
  }
  expect(all.map((o: any) => o.id)).toEqual(blobs.map((b: any) => b.id));
  expect(atob(all.find((o: any) => o.id === blobs[0].id).data_b64)).toBe('a\n');

  // Unknown ids and kind mismatches are reported missing, not guessed.
  const odd = await api(`${repo}/objects`, owner, {
    body: { objects: [{ id: 'f'.repeat(40), kind: 'blob' }, { id: blobs[0].id, kind: 'tree' }] },
  });
  expect(odd.body.missing).toEqual(['f'.repeat(40), blobs[0].id]);
  // Lookups run concurrently, so the store records misses in completion order.
  expect([...misses].sort()).toEqual([`blob:${'f'.repeat(40)}`, `tree:${blobs[0].id}`].sort());
  expect((await api(`${repo}/objects`, owner, { body: { objects: [{ id: 'nope', kind: 'blob' }] } })).status).toBe(400);
  // Signed out, a private repository is not there at all (repo-visibility).
  expect((await api(`${repo}/objects`, {}, { body: { objects: blobs } })).status).toBe(404);
});

it('serves a large blob as a stub to a client that downloads it on its own request', async () => {
  const owner = { cookie: await signup('largeowner') };
  const text = 'z'.repeat(3 * 1024 * 1024);
  const created = await api('/repos', owner, {
    body: { name: 'large', policy: { required_checks: [], approvals: 0 }, files: [file('big.txt', text), file('a.txt', 'a\n')], author },
  });
  const repo = `/repos/${created.body.id}`;
  const tree = await api(`${repo}/objects`, owner, { body: { objects: [{ id: created.body.tree, kind: 'tree' }] } });
  const id = (name: string) => tree.body.objects[0].entries.find((e: any) => e.name === name).id;
  const blobs = [{ id: id('big.txt'), kind: 'blob' }, { id: id('a.txt'), kind: 'blob' }];
  // Asked with `large`: the big blob is a stub, the small one inline; without it, both inline.
  const page = await api(`${repo}/objects`, owner, { body: { objects: blobs, large: true } });
  expect(page.body.objects[0]).toEqual({ id: id('big.txt'), kind: 'blob', size: text.length, large: true });
  expect(atob(page.body.objects[1].data_b64)).toBe('a\n');
  const inline = await api(`${repo}/objects`, owner, { body: { objects: blobs.slice(0, 1) } });
  expect(inline.body.objects[0].data_b64.length).toBeGreaterThan(text.length);
  // The stub's bytes, raw.
  const download = await SELF_FETCH(`${repo}/objects/${id('big.txt')}`, owner.cookie);
  expect(download.status).toBe(200);
  expect(download.headers.get('content-type')).toBe('application/octet-stream');
  expect(await download.text()).toBe(text);
  expect((await SELF_FETCH(`${repo}/objects/${'f'.repeat(40)}`, owner.cookie)).status).toBe(404);
  // Signed out, a private repository is not there at all.
  expect((await SELF_FETCH(`${repo}/objects/${id('big.txt')}`)).status).toBe(404);
});

it('resumes a large blob download from a byte offset (HTTP Range)', async () => {
  const owner = { cookie: await signup('rangeowner') };
  const text = Array.from({ length: 3 * 1024 * 1024 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
  const created = await api('/repos', owner, {
    body: { name: 'ranged', policy: { required_checks: [], approvals: 0 }, files: [file('big.txt', text)], author },
  });
  const repo = `/repos/${created.body.id}`;
  const tree = await api(`${repo}/objects`, owner, { body: { objects: [{ id: created.body.tree, kind: 'tree' }] } });
  const big = tree.body.objects[0].entries[0].id;
  const from = 1_000_003;
  const rest = await SELF_FETCH(`${repo}/objects/${big}`, owner.cookie, { range: `bytes=${from}-` });
  expect(rest.status).toBe(206);
  expect(rest.headers.get('content-range')).toBe(`bytes ${from}-${text.length - 1}/${text.length}`);
  expect(rest.headers.get('content-length')).toBe(String(text.length - from));
  expect(await rest.text()).toBe(text.slice(from));
  const middle = await SELF_FETCH(`${repo}/objects/${big}`, owner.cookie, { range: 'bytes=10-19' });
  expect(middle.status).toBe(206);
  expect(await middle.text()).toBe(text.slice(10, 20));
  // Past the end: 416 with the size, so the client restarts instead of guessing.
  const past = await SELF_FETCH(`${repo}/objects/${big}`, owner.cookie, { range: `bytes=${text.length}-` });
  expect(past.status).toBe(416);
  expect(past.headers.get('content-range')).toBe(`bytes */${text.length}`);
  // A range this endpoint does not serve (several, or a suffix) gets the whole blob.
  const whole = await SELF_FETCH(`${repo}/objects/${big}`, owner.cookie, { range: 'bytes=0-1,5-6' });
  expect(whole.status).toBe(200);
  expect((await whole.text()).length).toBe(text.length);
});

it('answers a large-blob download with a retryable 503 when its store read never settles', async () => {
  const owner = { cookie: await signup('stallowner') };
  const created = await api('/repos', owner, {
    body: { name: 'stalls', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author },
  });
  const repo = `/repos/${created.body.id}`;
  const tree = await api(`${repo}/objects`, owner, { body: { objects: [{ id: created.body.tree, kind: 'tree' }] } });
  const blob = tree.body.objects[0].entries[0].id;
  const spy = vi.spyOn(RepoObjects.prototype, 'blob').mockImplementation(() => new Promise<Uint8Array>(() => {}));
  const saved = DOWNLOAD_DEADLINE.ms;
  DOWNLOAD_DEADLINE.ms = 300;
  try {
    const began = Date.now();
    const download = await SELF_FETCH(`${repo}/objects/${blob}`, owner.cookie);
    expect(download.status).toBe(503);
    expect((await download.json<any>()).error.code).toBe('TIMEOUT');
    expect(Date.now() - began).toBeLessThan(5_000);
  } finally {
    DOWNLOAD_DEADLINE.ms = saved;
    spy.mockRestore();
  }
  // The deadline only bounds a stuck read: the download works again.
  expect(await (await SELF_FETCH(`${repo}/objects/${blob}`, owner.cookie)).text()).toBe('a\n');
});

/** A raw (non-JSON) GET of the platform API. */
const SELF_FETCH = (path: string, cookie?: string, headers: Record<string, string> = {}) =>
  platformFetch(new Request(`https://yoneda/api/v1${path}`, { headers: { ...headers, ...(cookie ? { cookie } : {}) } }), scoped);

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function gitId(kind: string, data: Uint8Array) {
  const header = new TextEncoder().encode(`${kind} ${data.length}\0`);
  const all = new Uint8Array(header.length + data.length);
  all.set(header);
  all.set(data, header.length);
  return hex(await crypto.subtle.digest('SHA-1', all));
}
const bytesOf = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

it('serves exact commit objects, and replays a commit made elsewhere byte for byte', async () => {
  const owner = { cookie: await signup('rawowner') };
  // Large enough to be pushed to the object store rather than staged.
  const big = { path: 'x.bin', content_b64: btoa('x'.repeat(2 * 1024 * 1024)) };
  const created = await api('/repos', owner, {
    body: { name: 'raw', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n'), big], author },
  });
  const repo = `/repos/${created.body.id}`;
  const root = created.body.commit as string;
  // A local commit's exact author, committer and message: the platform builds the same object.
  const message = 'replayed\n\nwith a body\n';
  const made = await api(`${repo}/commits`, owner, {
    body: {
      parent: root, base_version: 1, changes: [file('b.txt', 'b\n')], message,
      author: { name: 'Ada', email: 'ada@example.com', time: 1_700_000_000, tz: '+0130' },
      committer: { name: 'Bob', email: 'bob@example.com', time: 1_700_000_060, tz: '-0700' },
    },
  });
  expect(made.status).toBe(200);
  const expected =
    `tree ${made.body.tree}\nparent ${root}\n` +
    'author Ada <ada@example.com> 1700000000 +0130\n' +
    `committer Bob <bob@example.com> 1700000060 -0700\n\n${message}`;
  expect(made.body.commit).toBe(await gitId('commit', new TextEncoder().encode(expected)));

  const wanted = [{ id: root, kind: 'commit' }, { id: made.body.commit, kind: 'commit' }];
  const exact = await api(`${repo}/objects`, owner, { body: { objects: wanted, raw: true } });
  expect(exact.body.missing).toEqual([]);
  for (const object of exact.body.objects) {
    expect(object.kind).toBe('commit');
    expect(await gitId('commit', bytesOf(object.data_b64))).toBe(object.id);
  }
  expect(new TextDecoder().decode(bytesOf(exact.body.objects[1].data_b64))).toBe(expected);
  // Without `raw`, commits keep their tree-and-parents form.
  const shaped = await api(`${repo}/objects`, owner, { body: { objects: wanted } });
  expect(shaped.body.objects[1]).toEqual({ id: made.body.commit, kind: 'commit', tree: made.body.tree, parents: [root] });
  // A malformed committer is refused, not silently replaced.
  const refused = await api(`${repo}/commits`, owner, {
    body: { parent: root, base_version: 1, changes: [file('c.txt', 'c\n')], message: 'x', author, committer: { name: 'B', email: 'b@x', tz: 'utc' } },
  });
  expect(refused.status).toBe(400);
});

it('checks a blob read from the store of record against its id without Rust compute', async () => {
  // `git hash-object` of "hello\n".
  expect(await gitObjectId('blob', new TextEncoder().encode('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  const owner = { cookie: await signup('pagesowner') };
  // 12 blobs of 2 MB: a page stops at its response budget (16 MiB of base64, six of them)
  // and every blob still arrives, in order, across pages. (Kept small for CI's runners.)
  const files = Array.from({ length: 12 }, (_, i) => file(`c${i}.md`, `${i}`.padEnd(2_000_000, 'x')));
  const created = await api('/repos', owner, { body: { name: 'pages', policy: { required_checks: [], approvals: 0 }, files, author } });
  const repo = `/repos/${created.body.id}`;
  const tree = await api(`${repo}/objects`, owner, { body: { objects: [{ id: created.body.tree, kind: 'tree' }] } });
  const blobs = tree.body.objects[0].entries.map((e: any) => ({ id: e.id, kind: 'blob' }));
  const got: any[] = [];
  let after = 0;
  let pages = 0;
  for (;;) {
    const page = await api(`${repo}/objects`, owner, { body: { objects: blobs, after, large: true } });
    expect(page.status).toBe(200);
    got.push(...page.body.objects);
    pages++;
    if (page.body.next === null) break;
    after = page.body.next;
  }
  expect(got.map((o) => o.id)).toEqual(blobs.map((b: any) => b.id));
  expect(pages).toBeGreaterThanOrEqual(2);
  expect(pages).toBeLessThanOrEqual(3);
});

it('reads trees and commits wide, blobs a few at a time', () => {
  const id = (i: number) => i.toString(16).padStart(40, '0');
  const of = (kind: 'tree' | 'blob' | 'commit', n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ id: id(from + i), kind }));
  expect(nextBatch(of('tree', 100), 0)).toHaveLength(64);
  expect(nextBatch(of('blob', 100), 0)).toHaveLength(8);
  // Mixed: trees run on until the ninth blob.
  const mixed = [...of('tree', 5), ...of('blob', 10, 5), ...of('commit', 3, 15)];
  expect(nextBatch(mixed, 0)).toHaveLength(13);
  expect(nextBatch(mixed, 13)).toEqual(mixed.slice(13));
});

it('streams a page as JSON, a few large blobs in flight, every object whole and in order', async () => {
  const owner = { cookie: await signup('streamowner') };
  // 10 blobs just under the stub size: the page streams at most 8 of them at a time.
  const files = Array.from({ length: 10 }, (_, i) => file(`s${i}.bin`, `${i}`.padEnd(1_900_000, 'y')));
  const created = await api('/repos', owner, { body: { name: 'streamed', policy: { required_checks: [], approvals: 0 }, files, author } });
  const repo = `/repos/${created.body.id}`;
  const tree = await api(`${repo}/objects`, owner, { body: { objects: [{ id: created.body.tree, kind: 'tree' }] } });
  const blobs = tree.body.objects[0].entries.map((e: any) => ({ id: e.id, kind: 'blob' }));
  const page = await platformFetch(
    new Request(`https://yoneda/api/v1${repo}/objects`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ objects: blobs, large: true }),
    }),
    scoped,
  );
  expect(page.headers.get('content-type')).toBe('application/json');
  const body = await page.json<any>();
  // 16 MiB of base64 holds 6 of them: the next page starts after the sixth.
  expect(body.objects.map((o: any) => o.id)).toEqual(blobs.slice(0, body.objects.length).map((b: any) => b.id));
  expect(body.objects.length).toBeGreaterThanOrEqual(6);
  expect(body.next).toBe(body.objects.length);
  expect(body.objects.every((o: any) => atob(o.data_b64).length === 1_900_000)).toBe(true);
});

it('ends a page at its deadline with what it served, or answers 503 TIMEOUT before any object', async () => {
  const owner = { cookie: await signup('deadlineowner') };
  const files = Array.from({ length: 9 }, (_, i) => file(`d${i}.txt`, `${i}\n`));
  const created = await api('/repos', owner, { body: { name: 'deadline', policy: { required_checks: [], approvals: 0 }, files, author } });
  const repo = `/repos/${created.body.id}`;
  const tree = await api(`${repo}/objects`, owner, { body: { objects: [{ id: created.body.tree, kind: 'tree' }] } });
  const blobs = tree.body.objects[0].entries.map((e: any) => ({ id: e.id, kind: 'blob' }));
  const slow = blobs[8].id;
  const original = RepoObjects.prototype.blob;
  // The ninth blob (the second batch) never settles; every other read is as usual.
  const spy = vi
    .spyOn(RepoObjects.prototype, 'blob')
    .mockImplementation(function (this: RepoObjects, id: string) {
      return id === slow ? new Promise<Uint8Array>(() => {}) : original.call(this, id);
    });
  const saved = PAGE_DEADLINE.ms;
  PAGE_DEADLINE.ms = 1_500;
  try {
    const page = await api(`${repo}/objects`, owner, { body: { objects: blobs } });
    expect(page.status).toBe(200);
    expect(page.body.objects.map((o: any) => o.id)).toEqual(blobs.slice(0, 8).map((b: any) => b.id));
    expect(page.body.next).toBe(8);
    const stuck = await api(`${repo}/objects`, owner, { body: { objects: blobs, after: 8 } });
    expect([stuck.status, stuck.body.error?.code]).toEqual([503, 'TIMEOUT']);
  } finally {
    PAGE_DEADLINE.ms = saved;
    spy.mockRestore();
  }
});

it('refuses a page holding a quarantined blob before it starts, wherever the blob is', async () => {
  const cookie = await signup('withheldpages');
  const files = Array.from({ length: 12 }, (_, i) => file(`w${i}.txt`, `${i}\n`));
  const created = await api('/repos', { cookie }, { body: { name: 'withheld', policy: { required_checks: [], approvals: 0 }, files, author } });
  const repo = `/repos/${created.body.id}`;
  const tree = await api(`${repo}/objects`, { cookie }, { body: { objects: [{ id: created.body.tree, kind: 'tree' }] } });
  const entries = tree.body.objects[0].entries;
  const blobs = entries.map((e: any) => ({ id: e.id, kind: 'blob' }));
  const last = entries.at(-1);
  expect((await api(`${repo}/quarantine`, { cookie }, { body: { blob: last.id, path: last.name, reason: 'leak' } })).status).toBe(200);
  // The withheld blob is the last of the page: the page is refused, not cut short after
  // eleven objects of a streamed 200.
  const page = await api(`${repo}/objects`, { cookie }, { body: { objects: blobs } });
  expect([page.status, page.body.error?.code]).toEqual([451, 'QUARANTINED']);
  // A page without it is served.
  expect((await api(`${repo}/objects`, { cookie }, { body: { objects: blobs.slice(0, 11) } })).body.objects).toHaveLength(11);
});
