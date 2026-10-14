import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { cacheSourceBlob } from '../../cloudflare/worker/source-cache';
import type { SourceRevision } from '../../cloudflare/worker/source-contract';
import { hex } from '../../cloudflare/worker/source-crypto';
import { ensureSourceIndex, preparedSourceView, sourceIndexBounded } from '../../cloudflare/worker/source-index';
import { sourcePath } from '../../cloudflare/worker/source-path';
import { sourceContentKey } from '../../cloudflare/worker/source-storage';
import { streamProof } from '../../cloudflare/worker/source-stream';
import { verifySourceView } from '../../cloudflare/worker/source-view-proof';
import type { Env } from '../../cloudflare/worker/types';
import { sourceFixture } from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);

it('reads an immutable directory only once within each bounded preparation batch', async () => {
  const f = await fixture(20);
  const readTree = vi.mocked(f.repo.readTree);
  expect((await sourceIndexBounded(f.env, revision)).state).toBe('preparing');
  expect(readTree).toHaveBeenCalledTimes(1);
  expect((await sourceIndexBounded(f.env, revision)).state).toBe('prepared');
  expect(readTree).toHaveBeenCalledTimes(2);
});
const bindings = env as unknown as Env;
const encoder = new TextEncoder();
const revision: SourceRevision = { repository: 'yoneda-test/index-fixture', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const oid = async (bytes: Uint8Array) => {
  const prefix = encoder.encode(`blob ${bytes.length}\0`);
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix); input.set(bytes, prefix.length);
  return hex(await crypto.subtle.digest('SHA-1', input));
};
class StreamingBlob extends Blob {
  override arrayBuffer(): Promise<ArrayBuffer> { throw new Error('Whole-blob buffering is forbidden'); }
}
async function fixture(count = 20) {
  const bytes = new Uint8Array([0, 255, 192, 128, 10]);
  const hash = await oid(bytes);
  const entries = Array.from({ length: count }, (_, index) => ({ name: `file-${String(index).padStart(3, '0')}.bin`,
    hash, mode: '100644', type: 'blob' as const }));
  const readBlob = vi.fn(async () => new StreamingBlob([bytes]));
  const repo = { readCommit: vi.fn(async () => ({ hash: revision.commit, treeHash: revision.tree })),
    readTree: vi.fn(async () => entries.map(entry => ({ ...entry }))), readBlob, [Symbol.dispose]() {} } as unknown as ArtifactsRepo;
  const local = { ...bindings, ARTIFACTS: { get: vi.fn(async () => repo) } } as unknown as Env;
  return { env: local, repo, entries, bytes, hash, readBlob };
}

it('keeps partial index advisory, resumes without re-reading blob bodies, and retains all unread file identities', async () => {
  const f = await fixture();
  expect(await ensureSourceIndex(f.env, revision)).toEqual({ state: 'preparing', cursor: 0, files: 0, bytes: 0 });
  const first = await sourceIndexBounded(f.env, revision);
  expect(first.state).toBe('preparing');
  await expect(preparedSourceView(f.env, revision)).rejects.toMatchObject({ code: 'SOURCE_PREPARING' });
  const last = await sourceIndexBounded(f.env, revision);
  expect(last.state).toBe('prepared');
  const view = await preparedSourceView(f.env, revision);
  expect(view.files).toHaveLength(20);
  expect(view.files[19].content).toMatchObject({ blob: f.hash, path: 'file-019.bin' });
  expect(f.readBlob).toHaveBeenCalledTimes(1);
  expect(await sourceIndexBounded(f.env, revision, 0)).toEqual(last);
  expect(f.readBlob).toHaveBeenCalledTimes(1);
});

it('preserves opaque binary and empty blob hashes without arrayBuffer or text decoding', async () => {
  for (const bytes of [new Uint8Array(), new Uint8Array([0, 255, 128, 10])]) {
    const proof = await streamProof(new Blob([bytes]).stream(), bytes.length);
    expect(proof.git_oid).toBe(await oid(bytes));
    expect(proof.sha256).toBe(hex(await crypto.subtle.digest('SHA-256', bytes)));
    expect(proof.size).toBe(bytes.length);
  }
  await expect(streamProof(new Blob(['too long']).stream(), 1)).rejects.toMatchObject({ code: 'SOURCE_SIZE' });
});

it('checks frozen origin membership before reading an already-populated digest cache', async () => {
  const f = await fixture(1);
  await cacheSourceBlob(f.env, f.repo, revision, f.hash);
  const get = vi.spyOn(bindings.OBJECTS, 'get');
  const readTree = vi.mocked(f.repo.readTree);
  readTree.mockResolvedValue([{ name: 'file-000.bin', hash: 'e'.repeat(40), mode: '100644', type: 'blob' }]);
  await expect(sourceContentKey(f.env, { workspace_id: 'source-workspace:test', inputs: [revision] },
    { kind: 'git', repository: revision.repository, commit: revision.commit, path: 'file-000.bin', blob: f.hash }, f.bytes.length))
    .rejects.toMatchObject({ code: 'SOURCE_SCOPE' });
  expect(get).not.toHaveBeenCalled();
  get.mockRestore();
});

it('rejects a wrong approved tree, unsafe Git entries, and paths exceeding the native byte bound', async () => {
  const f = await fixture(1);
  await expect(sourceIndexBounded(f.env, { ...revision, tree: 'c'.repeat(40) })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  vi.mocked(f.repo.readTree).mockResolvedValue([{ name: 'escape', hash: f.hash, mode: '120000', type: 'symlink' }]);
  expect(await sourceIndexBounded(f.env, revision)).toEqual({ state: 'failed', error_code: 'SOURCE_OBJECT' });
  expect(f.readBlob).not.toHaveBeenCalled();
  expect(() => sourcePath('é'.repeat(300))).toThrow();
});

it('concurrent index progress converges with CAS and never duplicates file counts', async () => {
  const f = await fixture(18);
  await Promise.all([sourceIndexBounded(f.env, revision), sourceIndexBounded(f.env, revision)]);
  const prepared = await sourceIndexBounded(f.env, revision);
  expect(prepared.state).toBe('prepared');
  const view = await preparedSourceView(f.env, revision);
  expect(view.files).toHaveLength(18);
  expect(new Set(view.files.map(file => file.path)).size).toBe(18);
});

it('indexes supplementary Unicode filenames in the ordering accepted by the actual native SourceDO', async () => {
  const f = await fixture(2);
  f.entries[0].name = '\ue000.bin';
  f.entries[1].name = '\u{1f680}.bin';
  expect((await sourceIndexBounded(f.env, revision)).state).toBe('prepared');
  const view = await preparedSourceView(f.env, revision);
  const authority = await sourceFixture('unicode-index', { files: view.files, base: revision, protected_paths: [] });
  expect((await authority.rpc({ op: 'source_stat', path: '\u{1f680}.bin' })).exists).toBe(true);
});

it('activation checks completeness and origin links against the immutable root instead of trusting rebuildable metadata', async () => {
  const f = await fixture(2);
  expect((await sourceIndexBounded(f.env, revision)).state).toBe('prepared');
  const view = await preparedSourceView(f.env, revision);
  await expect(verifySourceView(f.env, view)).resolves.toBeUndefined();
  expect(f.readBlob).toHaveBeenCalledTimes(1);
  await expect(verifySourceView(f.env, { ...view, files: view.files.slice(1) })).rejects.toMatchObject({ code: 'SOURCE_INDEX' });
  const extra = { ...view.files[0], path: 'unapproved.bin' };
  await expect(verifySourceView(f.env, { ...view, files: [...view.files, extra] })).rejects.toMatchObject({ code: 'SOURCE_INDEX' });
  const forged = structuredClone(view);
  if (forged.files[0].content.kind === 'git') forged.files[0].content.path = 'other-origin.bin';
  await expect(verifySourceView(f.env, forged)).rejects.toMatchObject({ code: 'SOURCE_INDEX' });
});

it('a transient SDK failure does not permanently poison an immutable source index and retries retain cached progress', async () => {
  const f = await fixture(18);
  expect((await sourceIndexBounded(f.env, revision)).state).toBe('preparing');
  vi.mocked(f.repo.readTree).mockRejectedValueOnce(Object.assign(new Error('Synthetic SDK transport failure'), { code: 'INTERNAL_ERROR' }));
  await expect(sourceIndexBounded(f.env, revision)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  expect((await ensureSourceIndex(f.env, revision)).state).toBe('preparing');
  expect((await sourceIndexBounded(f.env, revision)).state).toBe('prepared');
  expect((await preparedSourceView(f.env, revision)).files).toHaveLength(18);
  expect(f.readBlob).toHaveBeenCalledTimes(1);
});
