import { sourceError } from './source-contract';
import { hex, sourceFingerprint } from './source-crypto';
import type { Env } from './types';

export type SourceCacheProof = {
  version: 1;
  size: number;
  sha256: string;
  git_oid: string;
  etag: string;
  key: string;
  certificate?: { version: 1; signature: string };
};
type Claims = Omit<SourceCacheProof, 'certificate'>;
const encoder = new TextEncoder();
async function key(env: Env, usage: 'sign' | 'verify') {
  if (!env.VAULT_KEY)
    throw sourceError('SOURCE_UNAVAILABLE', 'Source cache signing authority unavailable');
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`yoneda:source-cache:v1:${env.VAULT_KEY}`),
  );
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
const message = async (claims: Claims) =>
  encoder.encode(`yoneda:source-cache:v1\0${await sourceFingerprint(claims)}`);

/** Claims come only from the actual streamed bytes and R2 write/readback, never an unsigned record. */
export async function certifySourceCache(env: Env, claims: Claims): Promise<SourceCacheProof> {
  return {
    ...claims,
    certificate: {
      version: 1,
      signature: hex(
        await crypto.subtle.sign('HMAC', await key(env, 'sign'), await message(claims)),
      ),
    },
  };
}

export async function verifySourceCacheCertificate(env: Env, record: SourceCacheProof) {
  const { certificate, ...claims } = record;
  if (
    !certificate ||
    Object.keys(certificate).length !== 2 ||
    certificate.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(certificate.signature) ||
    Object.keys(record).some(
      (field) =>
        !['version', 'size', 'sha256', 'git_oid', 'etag', 'key', 'certificate'].includes(field),
    )
  )
    throw sourceError('SOURCE_CACHE_CERTIFICATE', 'Source byte cache certificate is invalid');
  const signature = Uint8Array.from(certificate.signature.match(/../g) ?? [], (value) =>
    Number.parseInt(value, 16),
  );
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      await key(env, 'verify'),
      signature,
      await message(claims),
    ))
  )
    throw sourceError('SOURCE_CACHE_CERTIFICATE', 'Source byte cache certificate differs');
}
