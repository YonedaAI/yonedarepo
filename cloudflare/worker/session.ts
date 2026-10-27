import { hmacHex, hmacKey } from './hmac';
import { response } from './http';
import type { Env } from './types';

const cookieName = 'yoneda_session';
const lifetime = 60 * 60 * 1000;
export async function sessionValid(req: Request, env: Env) {
  if (!env.OWNER_TOKEN) return false;
  const cookie = req.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  const [expiry, nonce, signature] = cookie?.split('.') ?? [];
  if (!expiry || !nonce || !signature || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expires = Number(expiry);
  if (!Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + lifetime)
    return false;
  const bytes = Uint8Array.from(signature.match(/.{2}/g) ?? [], (v) => Number.parseInt(v, 16));
  return crypto.subtle.verify(
    'HMAC',
    await hmacKey(env.OWNER_TOKEN),
    bytes,
    new TextEncoder().encode(`${expiry}.${nonce}`),
  );
}
export async function ownerSession(req: Request, env: Env) {
  let value = '';
  if (req.method === 'POST' && env.OWNER_TOKEN) {
    const payload = `${Date.now() + lifetime}.${crypto.randomUUID()}`;
    value = `${payload}.${await hmacHex(env.OWNER_TOKEN, payload)}`;
  }
  const result = response({ connected: Boolean(value) });
  result.headers.set('cache-control', 'no-store');
  result.headers.set(
    'set-cookie',
    `${cookieName}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${value ? lifetime / 1000 : 0}${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}`,
  );
  return result;
}
