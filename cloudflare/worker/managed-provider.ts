// Managed provider connections (dev and prod): the owner binds a deployment's Secrets Store key
// (Z.ai or MiMo only) to a named account without anyone pasting it. The account's vault holds
// an owner-bound reference, never the plaintext; the Worker resolves it from the binding at
// call time, so a rotated store key applies at once. Off unless the deployment sets
// MANAGED_PROVIDER_KEYS=secrets-store (the dev and prod agent Workers, infra/envs/*.json); with
// the flag off the route is absent and every stored reference fails closed.
import { providerDefinition } from '../../shared/providers';
import { username } from './accounts';
import { error, readJson, response } from './http';
import { writeLog } from './logging';
import type { Env, Json, Principal } from './types';
import { seal } from './vault';
import { workspace } from './workspace';

const PATH = '/api/admin/providers/managed';
const PROVIDERS = ['zai', 'mimo'];
const PREFIX = 'yoneda-managed:v1:';
const enabled = (env: Env) => env.MANAGED_PROVIDER_KEYS === 'secrets-store';
const missing = (message: string) =>
  Object.assign(new Error(message), { code: 'PROVIDER_MISSING' });

async function proof(env: Env, owner: string, provider: string) {
  if (!env.VAULT_KEY) throw missing('Provider vault is not configured');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`yoneda:managed-provider:v1:${env.VAULT_KEY}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${owner}\n${provider}`),
  );
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The deployment's Secrets Store key; validated against the saved route by the caller. */
async function storeKey(env: Env, provider: string) {
  const binding = env[providerDefinition(provider).secret_binding as keyof Env] as
    | { get?: () => Promise<unknown> }
    | undefined;
  const key = typeof binding?.get === 'function' ? await binding.get() : undefined;
  if (typeof key !== 'string' || !key) throw missing('Provider secret is not configured');
  return key;
}

/** The reference stored (sealed) for `owner`; only this Worker's VAULT_KEY can mint it. */
const reference = async (env: Env, owner: string, provider: string) =>
  `${PREFIX}${provider}:${await proof(env, owner, provider)}`;

/** Whether a value has the managed-reference shape; user-supplied keys never may. */
export const isManagedReference = (value: unknown) =>
  typeof value === 'string' && value.trim().startsWith(PREFIX);

/** Constant-time equality: fixed-length SHA-256 digests compared by the runtime. */
async function sameSecret(a: string, b: string) {
  const digest = (v: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

/**
 * The provider key behind a decrypted vault value: the value itself, or, for a managed
 * reference, the Secrets Store key. A reference that is forged, bound to another account
 * or read while the flag is off fails closed.
 */
export async function resolveProviderKey(env: Env, owner: string, provider: string, value: string) {
  if (!value.startsWith(PREFIX)) return value;
  if (
    !enabled(env) ||
    !PROVIDERS.includes(provider) ||
    !(await sameSecret(value, await reference(env, owner, provider)))
  )
    throw missing('Managed provider key is unavailable');
  return storeKey(env, provider);
}

/** POST /api/admin/providers/managed {username, provider, model?, routing?} (owner only). */
export async function managedProviderRoute(req: Request, env: Env, principal: Principal) {
  if (new URL(req.url).pathname !== PATH || !enabled(env)) return null;
  if (principal.role !== 'admin') return error('FORBIDDEN', 'Administrator required', 403);
  if (req.method !== 'POST') return error('NOT_FOUND', 'Unknown managed provider operation', 404);
  const input: Json = await readJson(req);
  if (Object.keys(input).some((key) => !['username', 'provider', 'model', 'routing'].includes(key)))
    return error('INVALID_INPUT', 'Only username, provider, model and routing are accepted');
  if (!PROVIDERS.includes(input.provider))
    return error('INVALID_INPUT', 'Only zai and mimo keys can be managed');
  const provider: string = input.provider;
  const model =
    input.model ??
    (provider === 'zai' ? env.ZAI_MODEL : env.MIMO_MODEL) ??
    providerDefinition(provider).default_model;
  if (!providerDefinition(provider).models.some((m) => m.id === model))
    return error('INVALID_INPUT', 'Choose a catalog model for this provider');
  const owner = username(input.username);
  try {
    await workspace(env, owner, { op: 'projects' });
  } catch (failure: any) {
    if (failure.code === 'NOT_FOUND') return error('NOT_FOUND', 'Account not found', 404);
    throw failure;
  }
  // Read the store key once to fail closed when unbound and to fix MiMo's billing route
  // (a tp-/ttp- Token Plan key needs its region; Singapore unless the owner names one).
  const key = await storeKey(env, provider);
  const routing =
    provider === 'mimo'
      ? (input.routing ??
        (/^(tp-|ttp-)/.test(key) ? { plan: 'token_plan', region: 'sgp' } : undefined))
      : undefined;
  const connection = `managed-${provider}`;
  const saved = await workspace(env, owner, {
    op: 'provider_put',
    provider,
    model,
    connection,
    label: `Managed ${providerDefinition(provider).name}`,
    ...(routing ? { routing } : {}),
    sealed: await seal(env, owner, provider, await reference(env, owner, provider), connection),
  });
  writeLog('provider.managed_bound', { provider, model, billing_source: 'secrets-store' });
  return response({
    id: saved.id,
    label: saved.label,
    provider,
    model,
    routing: saved.routing ?? null,
    version: saved.version,
    managed: true,
  });
}
