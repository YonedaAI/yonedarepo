import {
  certifySourceCache,
  type SourceCacheProof,
  verifySourceCacheCertificate,
} from './source-cache-proof';
import { SOURCE_LIMITS, type SourceRevision, sourceError } from './source-contract';
import { sourceFingerprint } from './source-crypto';
import type { SourceRepo } from './source-objects';
import { sourceOid } from './source-path';
import { sourceStream, streamProof } from './source-stream';
import type { Env } from './types';

export type { SourceCacheProof } from './source-cache-proof';
export const sourceCacheKey = async (revision: SourceRevision, oid: string) =>
  `source/v1/base/${await sourceFingerprint(revision)}/${sourceOid(oid)}`;

async function savedProof(env: Env, key: string, oid: string) {
  const object = await env.OBJECTS.get(`${key}.proof`);
  if (!object) return { value: null, etag: null };
  if (object.size > 2048) throw sourceError('SOURCE_CACHE', 'Invalid source cache proof');
  const proof = await object.json<SourceCacheProof>();
  // Absence is a legacy record, not permission to trust any of its claimed byte metadata.
  if (!proof || !Object.hasOwn(proof, 'certificate')) return { value: null, etag: object.etag };
  await verifySourceCacheCertificate(env, proof);
  if (proof.key !== key || proof.git_oid !== oid)
    throw sourceError(
      'SOURCE_CACHE_CERTIFICATE',
      'Source cache certificate belongs to another immutable object',
    );
  if (
    proof.version !== 1 ||
    proof.git_oid !== oid ||
    !/^[a-f0-9]{64}$/.test(proof.sha256) ||
    !Number.isSafeInteger(proof.size) ||
    proof.size < 0 ||
    proof.size > SOURCE_LIMITS.fileBytes ||
    typeof proof.etag !== 'string'
  )
    throw sourceError('SOURCE_CACHE', 'Invalid source cache proof');
  const body = await env.OBJECTS.head(key);
  if (!body || body.size !== proof.size || body.etag !== proof.etag)
    throw sourceError('SOURCE_CACHE', 'Source cache content differs from its immutable proof');
  return { value: proof, etag: object.etag };
}

/** Called only after the enclosing frozen commit/tree/path link has been verified. */
export async function cacheSourceBlob(
  env: Env,
  repo: SourceRepo,
  revision: SourceRevision,
  oid: string,
) {
  const key = await sourceCacheKey(revision, oid);
  const known = await savedProof(env, key, oid);
  if (known.value) return known.value;
  const existing = await env.OBJECTS.get(key);
  let proof: { size: number; sha256: string; git_oid: string };
  let object: R2Object;
  if (existing) {
    // Recover a completed cache write whose proof acknowledgement was lost.
    proof = await streamProof(existing.body, existing.size);
    object = existing;
  } else {
    const blob = await repo.readBlob(oid);
    if (!blob) throw sourceError('SOURCE_OBJECT', 'Source blob is missing');
    const measured = sourceStream(blob.stream(), blob.size);
    try {
      const stored = await env.OBJECTS.put(key, measured.body, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/octet-stream' },
      });
      if (!stored) {
        await measured.body.cancel('Concurrent immutable cache write').catch(() => {});
        await Promise.allSettled([measured.piped, measured.proof]);
        return cacheSourceBlob(env, repo, revision, oid);
      }
      await measured.piped;
      proof = await measured.proof;
      object = stored;
    } catch (failure) {
      await measured.body.cancel(failure).catch(() => {});
      await Promise.allSettled([measured.piped, measured.proof]);
      throw failure;
    }
  }
  if (proof.git_oid !== oid) {
    throw sourceError(
      'SOURCE_CHECKSUM',
      'Artifacts blob bytes differ from their frozen Git identity',
    );
  }
  const record = await certifySourceCache(env, { version: 1, ...proof, etag: object.etag, key });
  await env.OBJECTS.put(`${key}.proof`, JSON.stringify(record), {
    onlyIf: known.etag ? { etagMatches: known.etag } : { etagDoesNotMatch: '*' },
  });
  const confirmed = await savedProof(env, key, oid);
  if (!confirmed.value || confirmed.value.sha256 !== proof.sha256)
    throw sourceError('SOURCE_CACHE', 'Source cache proof changed');
  return confirmed.value;
}
