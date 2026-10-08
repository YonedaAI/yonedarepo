//! Provider keys are encrypted in the workspace DO and decrypted only at scoped egress.
import { error, readJson, response } from './http';
import type { Env, Json, Principal } from './types';
import { workspace } from './workspace';

const providers = ['codex', 'claude', 'mimo', 'zai'];
async function vaultKey(env: Env) {
  if (!env.VAULT_KEY || !/^[a-f0-9]{64}$/.test(env.VAULT_KEY))
    throw Object.assign(new Error('Provider vault is not configured'), {
      code: 'VAULT_UNCONFIGURED',
    });
  const bytes = Uint8Array.from(env.VAULT_KEY.match(/../g) ?? [], (v) => Number.parseInt(v, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function aad(owner: string, provider: string) {
  return new TextEncoder().encode(`yoneda:v1:${owner}:${provider}`);
}
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
function decode(value: string) {
  return Uint8Array.from(atob(value), (v) => v.charCodeAt(0));
}
export async function seal(env: Env, owner: string, provider: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(owner, provider) },
    await vaultKey(env),
    new TextEncoder().encode(secret),
  );
  return { v: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function open(env: Env, owner: string, provider: string, sealed: Json) {
  if (sealed.v !== 1) throw new Error('Unsupported provider vault version');
  const bytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(sealed.iv), additionalData: aad(owner, provider) },
    await vaultKey(env),
    decode(sealed.ciphertext),
  );
  return new TextDecoder().decode(bytes);
}
export async function providerKey(env: Env, owner: string, provider: string) {
  if (!providers.includes(provider)) throw new Error('Unsupported provider');
  if (owner === '_admin') {
    const bindings = {
      codex: env.OPENAI_KEY,
      claude: env.ANTHROPIC_KEY,
      mimo: env.MIMO_KEY,
      zai: env.ZAI_KEY,
    };
    const binding = bindings[provider as keyof typeof bindings];
    if (!binding)
      throw Object.assign(new Error('Provider secret is not configured'), {
        code: 'PROVIDER_MISSING',
      });
    return binding.get();
  }
  const value = await workspace(env, owner, { op: 'provider_secret', provider });
  return open(env, owner, provider, value.sealed);
}
export async function settingsRoute(
  req: Request,
  env: Env,
  principal: Principal,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith('/api/settings')) return null;
  if (principal.role !== 'user')
    return error('FORBIDDEN', 'Sign in with a personal account for provider settings', 403);
  if (path === '/api/settings' && req.method === 'GET') {
    const result = response(await workspace(env, principal.workspace, { op: 'settings' }));
    result.headers.set('cache-control', 'no-store');
    return result;
  }
  const provider = path.split('/')[4];
  if (path.split('/')[3] !== 'providers' || !providers.includes(provider))
    return error('NOT_FOUND', 'Unknown provider setting', 404);
  if (req.method === 'DELETE')
    return response(await workspace(env, principal.workspace, { op: 'provider_delete', provider }));
  if (req.method !== 'POST') return error('NOT_FOUND', 'Unknown provider setting', 404);
  const body = await readJson(req);
  if (
    typeof body.key !== 'string' ||
    body.key.trim().length < 8 ||
    body.key.length > 4096 ||
    /[\r\n]/.test(body.key)
  )
    return error('INVALID_INPUT', 'Enter a provider API key');
  if (provider === 'claude' && body.model !== 'claude-sonnet-4-6')
    return error('INVALID_INPUT', 'Claude testing uses claude-sonnet-4-6');
  const sealed = await seal(env, principal.workspace, provider, body.key.trim());
  const result = await workspace(env, principal.workspace, {
    op: 'provider_put',
    provider,
    model: body.model,
    sealed,
  });
  body.key = '';
  return response(result);
}
