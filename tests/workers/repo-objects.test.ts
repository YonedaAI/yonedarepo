// Batch, resumable object fetch through the tiered cache (Scion S11/S12).
import { expect, it } from 'vitest';
import { api, author, file, misses, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

it('serves objects by id from the cache tiers and resumes across the response budget', async () => {
  const owner = { cookie: await signup('objectowner') };
  const big = (fill: string) => ({ path: `${fill}.bin`, content_b64: btoa(fill.repeat(5 * 1024 * 1024)) });
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
  const rest = await api(`${repo}/objects`, owner, { body: { objects: blobs, after: first.body.next } });
  const all = [...first.body.objects, ...rest.body.objects];
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
  expect((await api(`${repo}/objects`, {}, { body: { objects: blobs } })).status).toBe(401);
});

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
