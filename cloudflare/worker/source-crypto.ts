import { canonicalJson } from './canonical-json';
import { sourceError } from './source-contract';
import { sha } from './storage';

export const sourceFingerprint = (value: unknown) =>
  sha(`yonedarepo:json:v1\0${canonicalJson(value)}`);
export const hex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Native SourceWorkspace uses a decoded 32-byte key, distinct from legacy campaign HMAC. */
export async function sourceMac(
  vault: string | undefined,
  domain: 'source-grant' | 'source-gc' | 'source-seal' | 'source-capture',
  claims: unknown,
) {
  if (!vault) throw sourceError('SOURCE_UNAVAILABLE', 'Source signing authority is unavailable');
  const derived = await sha(`yoneda:source-grant:v1:${vault}`);
  const bytes = Uint8Array.from(derived.match(/../g) ?? [], (value) => Number.parseInt(value, 16));
  const key = await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`yoneda:${domain}:v1\0${await sourceFingerprint(claims)}`),
    ),
  );
}
