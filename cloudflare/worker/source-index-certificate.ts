import { sourceError } from './source-contract';
import { hex, sourceFingerprint } from './source-crypto';
import type { IndexJournal, IndexManifest } from './source-index-journal';
import type { Env } from './types';

type ManifestClaims = Omit<IndexManifest, 'certificate'>;
const encoder = new TextEncoder();
async function key(env: Env, usage: 'sign' | 'verify') {
  if (!env.VAULT_KEY)
    throw sourceError('SOURCE_UNAVAILABLE', 'Source index signing authority unavailable');
  const derived = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`yoneda:source-index:v1:${env.VAULT_KEY}`),
  );
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
async function message(claims: unknown, domain = 'source-index') {
  return encoder.encode(`yoneda:${domain}:v1\0${await sourceFingerprint(claims)}`);
}

/** Only the completed bounded SDK/hash pipeline signs metadata, never model-supplied views. */
export async function certifySourceIndex(env: Env, claims: ManifestClaims): Promise<IndexManifest> {
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

/** Private certificate binds exact revision, chunk identities, complete counts and view digest. */
export async function verifySourceIndexCertificate(env: Env, manifest: IndexManifest) {
  const { certificate, ...claims } = manifest;
  if (!certificate)
    throw sourceError('SOURCE_INDEX_UNSIGNED', 'Source index requires bounded reconstruction');
  if (
    Object.keys(certificate).length !== 2 ||
    certificate.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(certificate.signature)
  )
    throw sourceError(
      'SOURCE_INDEX_CERTIFICATE',
      'Source index requires a valid private certificate',
    );
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
    throw sourceError('SOURCE_INDEX_CERTIFICATE', 'Source index certificate differs');
}

export async function certifySourceIndexJournal(
  env: Env,
  journal: IndexJournal,
): Promise<IndexJournal> {
  const { certificate: _prior, ...claims } = journal;
  return {
    ...claims,
    certificate: {
      version: 1,
      signature: hex(
        await crypto.subtle.sign(
          'HMAC',
          await key(env, 'sign'),
          await message(claims, 'source-index-journal'),
        ),
      ),
    },
  };
}

export async function verifySourceIndexJournal(env: Env, journal: IndexJournal) {
  const { certificate, ...claims } = journal;
  if (!certificate)
    throw sourceError('SOURCE_INDEX_UNSIGNED', 'Unsigned progress requires bounded reconstruction');
  if (
    Object.keys(certificate).length !== 2 ||
    certificate.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(certificate.signature)
  )
    throw sourceError('SOURCE_INDEX_CERTIFICATE', 'Source journal certificate is invalid');
  const signature = Uint8Array.from(certificate.signature.match(/../g) ?? [], (value) =>
    Number.parseInt(value, 16),
  );
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      await key(env, 'verify'),
      signature,
      await message(claims, 'source-index-journal'),
    ))
  )
    throw sourceError('SOURCE_INDEX_CERTIFICATE', 'Source journal certificate differs');
}
