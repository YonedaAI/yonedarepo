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
