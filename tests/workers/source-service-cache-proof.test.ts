import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { cacheSourceBlob, sourceCacheKey } from '../../cloudflare/worker/source-cache';
import { hex } from '../../cloudflare/worker/source-crypto';
import { streamProof } from '../../cloudflare/worker/source-stream';
import { bindings } from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);
async function fixture() {
  const bytes = new Uint8Array([0, 255, 128, 10]);
  const proof = await streamProof(new Blob([bytes]).stream(), bytes.length);
  const revision = { repository: 'yoneda-test/cache-proof', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const key = await sourceCacheKey(revision, proof.git_oid);
  const readBlob = vi.fn(async () => new Blob([bytes]));
  const repo = { readBlob } as unknown as ArtifactsRepo;
  return { bytes, proof, revision, key, readBlob, repo };
}

it('does not trust an unsigned cache proof whose claimed Git identity matches but actual body differs', async () => {
  const f = await fixture();
  const wrong = new Uint8Array([1, 2, 3, 4]);
  const object = await bindings.OBJECTS.put(f.key, wrong);
  await bindings.OBJECTS.put(`${f.key}.proof`, JSON.stringify({ version: 1, key: f.key,
    size: wrong.length, git_oid: f.proof.git_oid, etag: object!.etag,
    sha256: hex(await crypto.subtle.digest('SHA-256', wrong)) }));
  await expect(cacheSourceBlob(bindings, f.repo, f.revision, f.proof.git_oid)).rejects.toMatchObject({ code: 'SOURCE_CHECKSUM' });
  expect(f.readBlob).not.toHaveBeenCalled();
});

it('recovers unsigned claims only from a streamed body, then reuses the valid private MAC without reading the body again', async () => {
  const f = await fixture();
  const body = await bindings.OBJECTS.put(f.key, f.bytes);
  await bindings.OBJECTS.put(`${f.key}.proof`, JSON.stringify({ version: 1, key: 'forged',
    size: 999, git_oid: '0'.repeat(40), etag: body!.etag, sha256: '0'.repeat(64) }));
  const recovered = await cacheSourceBlob(bindings, f.repo, f.revision, f.proof.git_oid);
  expect(recovered).toMatchObject({ ...f.proof, key: f.key, size: f.bytes.length });
  expect(recovered.certificate?.version).toBe(1);
  const get = vi.spyOn(bindings.OBJECTS, 'get');
  try {
    await cacheSourceBlob(bindings, f.repo, f.revision, f.proof.git_oid);
    expect(get.mock.calls.filter(([key]) => key === f.key)).toHaveLength(0);
    expect(f.readBlob).not.toHaveBeenCalled();
  } finally { get.mockRestore(); }
});

it('refuses a corrupt MAC and a valid proof replayed under a different immutable cache root', async () => {
  const f = await fixture();
  await cacheSourceBlob(bindings, f.repo, f.revision, f.proof.git_oid);
  const record = await (await bindings.OBJECTS.get(`${f.key}.proof`))!.json<any>();
  const other = { ...f.revision, commit: 'c'.repeat(40) };
  const otherKey = await sourceCacheKey(other, f.proof.git_oid);
  await bindings.OBJECTS.put(otherKey, f.bytes);
  await bindings.OBJECTS.put(`${otherKey}.proof`, JSON.stringify(record));
  await expect(cacheSourceBlob(bindings, f.repo, other, f.proof.git_oid)).rejects.toMatchObject({ code: 'SOURCE_CACHE_CERTIFICATE' });
  record.certificate.signature = '0'.repeat(64);
  await bindings.OBJECTS.put(`${f.key}.proof`, JSON.stringify(record));
  await expect(cacheSourceBlob(bindings, f.repo, f.revision, f.proof.git_oid)).rejects.toMatchObject({ code: 'SOURCE_CACHE_CERTIFICATE' });
});
