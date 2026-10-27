// HMAC-SHA256 with a shared secret: owner session cookies and webhook signatures. Imports
// nothing, so platform and agent-layer modules can both use it.
const encoder = new TextEncoder();

export function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export const toHex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join('');

/** Lowercase hex HMAC-SHA256 of `data`. */
export async function hmacHex(secret: string, data: string) {
  return toHex(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(data)));
}
