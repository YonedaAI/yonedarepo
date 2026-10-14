import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { hex } from '../../cloudflare/worker/source-crypto';
import { refreshBlob, refreshRevision, refreshTree } from '../../cloudflare/worker/source-refresh-git';
import type { Env } from '../../cloudflare/worker/types';
import { bindings } from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);

async function fixture() {
  const revision = { repository: 'yoneda-test/refresh-source', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const bytes = new Uint8Array([0, 255, 128, 10]);
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const raw = new Uint8Array(prefix.length + bytes.length); raw.set(prefix); raw.set(bytes, prefix.length);
  const blob = hex(await crypto.subtle.digest('SHA-1', raw));
  const readBlob = vi.fn(async () => new Blob([bytes]));
  const entries = [{ name: 'booking.bin', mode: '100644', type: 'blob', hash: blob }];
  const repo = { readCommit: vi.fn(async () => ({ hash: revision.commit, treeHash: revision.tree, parents: ['c'.repeat(40)] })),
    readTree: vi.fn(async () => entries.map(e => ({ ...e }))), readBlob, [Symbol.dispose]() {} } as unknown as ArtifactsRepo;
  const get = vi.fn(async () => repo);
  return { env: { ...bindings, ARTIFACTS: { get } } as unknown as Env, revision, bytes, repo, get, readBlob, entries };
}

it('resolves exact trusted refresh Git roots without reading blob bodies and rejects foreign namespaces before SDK access', async () => {
  const f = await fixture();
  await expect(refreshRevision(f.env, { ...f.revision, repository: 'foreign/refresh-source' })).rejects.toMatchObject({ code: 'SOURCE_SCOPE' });
  expect(f.get).not.toHaveBeenCalled();
  expect(await refreshRevision(f.env, f.revision)).toEqual({ revision: f.revision, parents: ['c'.repeat(40)] });
  expect(f.readBlob).not.toHaveBeenCalled();
  await expect(refreshRevision(f.env, { ...f.revision, tree: '0'.repeat(40) })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  vi.mocked(f.repo.readCommit).mockResolvedValueOnce({ hash: 'd'.repeat(40), treeHash: f.revision.tree, parents: [] } as ArtifactsCommitMetadata);
  await expect(refreshRevision(f.env, f.revision)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
});

it('preserves binary ranges and reports a deleted merge input without reading unrelated blobs', async () => {
  const f = await fixture();
  const response = await refreshBlob(f.env, f.revision, { path: 'booking.bin', offset: 1, limit: 2 });
  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toBe('bytes 1-2/4');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.bytes.slice(1, 3));
  expect(f.readBlob).toHaveBeenCalledTimes(1);
  await expect(refreshBlob(f.env, f.revision, { path: 'deleted.bin' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(refreshBlob(f.env, f.revision, { path: '../secret' })).rejects.toMatchObject({ code: 'SOURCE_PATH' });
  expect(f.readBlob).toHaveBeenCalledTimes(1);
});

it('pages refresh metadata in native UTF8 order and refuses symlink traversal before content cache access', async () => {
  const f = await fixture();
  f.entries.splice(0, 1, { name: '🚀', mode: '100644', type: 'blob', hash: 'e'.repeat(40) },
    { name: '\uE000', mode: '100644', type: 'blob', hash: 'f'.repeat(40) });
  const first = await refreshTree(f.env, f.revision, { path: '', limit: 1 });
  expect(await first.json()).toMatchObject({ tree_oid: f.revision.tree, items: [{ name: '\uE000' }], next_cursor: '\uE000' });
  const second = await refreshTree(f.env, f.revision, { path: '', cursor: '\uE000', limit: 1 });
  expect(await second.json()).toMatchObject({ items: [{ name: '🚀' }], next_cursor: null });
  f.entries.splice(0, 2, { name: 'link', mode: '120000', type: 'symlink', hash: 'e'.repeat(40) });
  await expect(refreshBlob(f.env, f.revision, { path: 'link' })).rejects.toMatchObject({ code: 'SOURCE_OBJECT' });
  expect(f.readBlob).not.toHaveBeenCalled();
});
