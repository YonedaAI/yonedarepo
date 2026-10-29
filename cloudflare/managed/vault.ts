// Secrets the managed Worker keeps (each repository's agent token and webhook signing secret)
// are sealed at rest with AES-GCM under MANAGED_VAULT_KEY, a Worker secret (64 hex characters),
// the platform's vault pattern. The additional data binds a sealed value to its repository and
// field, so a value copied to another row or repository does not open. A missing or malformed
// key fails closed.
import type { ManagedEnv } from './config';

export interface Sealed {
  v: 1;
  iv: string;
  ciphertext: string;
}

async function vaultKey(env: ManagedEnv) {
  const hex = env.MANAGED_VAULT_KEY ?? '';
  if (!/^[a-f0-9]{64}$/.test(hex))
    throw Object.assign(new Error('The managed agents vault is not configured'), {
      code: 'VAULT_UNCONFIGURED',
    });
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], (v) => Number.parseInt(v, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const aad = (repo: string, field: string) =>
  new TextEncoder().encode(`yoneda-managed:v1:${repo}:${field}`);
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

export async function seal(
  env: ManagedEnv,
  repo: string,
  field: string,
  secret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(repo, field) },
    await vaultKey(env),
    new TextEncoder().encode(secret),
  );
  const sealed: Sealed = { v: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
  return JSON.stringify(sealed);
}

export async function open(
  env: ManagedEnv,
  repo: string,
  field: string,
  stored: string,
): Promise<string> {
  const sealed = JSON.parse(stored) as Sealed;
  if (sealed.v !== 1) throw new Error('Unsupported managed vault version');
  const bytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(sealed.iv), additionalData: aad(repo, field) },
    await vaultKey(env),
    decode(sealed.ciphertext),
  );
  return new TextDecoder().decode(bytes);
}
