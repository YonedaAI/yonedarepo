//! Provider keys are encrypted in the workspace DO and decrypted only at scoped egress.
import type { Env, Json } from './types';
import { workspace } from './workspace';

const providers = ['codex', 'claude', 'mimo', 'zai', 'gemini'];
async function vaultKey(env: Env) {
  if (!env.VAULT_KEY || !/^[a-f0-9]{64}$/.test(env.VAULT_KEY))
    throw Object.assign(new Error('Provider vault is not configured'), {
      code: 'VAULT_UNCONFIGURED',
    });
  const bytes = Uint8Array.from(env.VAULT_KEY.match(/../g) ?? [], (v) => Number.parseInt(v, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function aad(owner: string, provider: string, connection?: string) {
  return new TextEncoder().encode(
    connection ? `yoneda:v2:${owner}:${provider}:${connection}` : `yoneda:v1:${owner}:${provider}`,
  );
}
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
function decode(value: string) {
  return Uint8Array.from(atob(value), (v) => v.charCodeAt(0));
}
export async function seal(
  env: Env,
  owner: string,
  provider: string,
  secret: string,
  connection?: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(owner, provider, connection) },
    await vaultKey(env),
    new TextEncoder().encode(secret),
  );
  return { v: connection ? 2 : 1, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function open(
  env: Env,
  owner: string,
  provider: string,
  sealed: Json,
  connection?: string,
) {
  if (![1, 2].includes(sealed.v) || (sealed.v === 2 && !connection))
    throw new Error('Unsupported provider vault version');
  const bytes = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decode(sealed.iv),
      additionalData: aad(owner, provider, sealed.v === 2 ? connection : undefined),
    },
    await vaultKey(env),
    decode(sealed.ciphertext),
  );
  return new TextDecoder().decode(bytes);
}
export async function providerKey(
  env: Env,
  owner: string,
  provider: string,
  connection?: string,
  model?: string,
) {
  if (!providers.includes(provider)) throw new Error('Unsupported provider');
  if (owner === '_admin') {
    const bindings = {
      codex: env.OPENAI_KEY,
      claude: env.ANTHROPIC_KEY,
      mimo: env.MIMO_KEY,
      zai: env.ZAI_KEY,
      gemini: env.GEMINI_KEY,
    };
    const binding = bindings[provider as keyof typeof bindings];
    if (!binding)
      throw Object.assign(new Error('Provider secret is not configured'), {
        code: 'PROVIDER_MISSING',
      });
    return binding.get();
  }
  const value = await workspace(env, owner, {
    op: 'provider_secret',
    provider,
    ...(connection ? { connection } : {}),
  });
  if (model && value.model !== model)
    throw new Error('Provider model changed after run approval; start a new run');
  return open(env, owner, provider, value.sealed, connection);
}
