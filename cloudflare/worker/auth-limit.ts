// Front auth counters use the primary platform's placed default HTTP fetch handler.
// Placement does not cover RPC/named entrypoints. Already-shared OWNER_TOKEN signs only
// this purpose; the operator credential itself never travels in a request.
import { hmacHex, hmacKey } from './hmac';
import { error, readJson, response } from './http';
import type { Env } from './types';

export const AUTH_LIMIT_PATH = '/internal/auth-limit';
const SIGNATURE = 'x-yoneda-auth-limit';
const FRESH_MS = 60_000;
const SERVICE_MS = 5_000;
const validKey = (key: unknown): key is string =>
  typeof key === 'string' &&
  key.length > 0 &&
  key.length <= 256 &&
  [...key].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
const payload = (key: string, at: number) => `yoneda:placed-auth-limit:v1\n${at}\n${key}`;

/** The raw primary default service binding, never its named/RPC/routing proxy. */
export async function placedAuthLimit(platform: Fetcher, secret: string | undefined, key: string) {
  if (!secret) throw new Error('The auth service is not configured');
  if (!validKey(key)) return { success: false };
  const at = Date.now();
  const signature = await hmacHex(secret, payload(key, at));
  const answer = await platform.fetch(
    new Request(`https://platform${AUTH_LIMIT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIGNATURE]: signature },
      body: JSON.stringify({ key, at }),
      redirect: 'manual',
      signal: AbortSignal.timeout(SERVICE_MS),
    }),
  );
  if (!answer.ok) throw new Error('The auth service is unavailable');
  const value = await answer.json<{ success?: unknown }>();
  return { success: value.success === true };
}

/** Authenticated service traffic only. Unsigned/tampered/stale calls spend nothing. */
export async function authLimitResponse(
  req: Request,
  env: Pick<Env, 'OWNER_TOKEN' | 'AUTH_LIMITER'>,
) {
  const signature = req.headers.get(SIGNATURE);
  if (req.method !== 'POST' || !env.OWNER_TOKEN || !signature || !/^[a-f0-9]{64}$/.test(signature))
    return error('UNAUTHORIZED', 'Not authorized', 401);
  let body: { key?: unknown; at?: unknown };
  try {
    body = await readJson(req, 1024);
  } catch {
    return error('INVALID_INPUT', 'Invalid request', 400);
  }
  const { key, at } = body;
  if (
    !validKey(key) ||
    typeof at !== 'number' ||
    !Number.isSafeInteger(at) ||
    Math.abs(Date.now() - at) > FRESH_MS
  )
    return error('UNAUTHORIZED', 'Not authorized', 401);
  const bytes = Uint8Array.from(signature.match(/../g) ?? [], (hex) => Number.parseInt(hex, 16));
  const verified = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(env.OWNER_TOKEN),
    bytes,
    new TextEncoder().encode(payload(key, at)),
  );
  if (!verified) return error('UNAUTHORIZED', 'Not authorized', 401);
  if (!env.AUTH_LIMITER) return error('UNAVAILABLE', 'The auth service is unavailable', 503);
  return response(await env.AUTH_LIMITER.limit({ key }));
}
