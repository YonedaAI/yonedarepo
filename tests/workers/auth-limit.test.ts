import { expect, it } from 'vitest';
import { AUTH_LIMIT_PATH, authLimitResponse, placedAuthLimit } from '../../cloudflare/worker/auth-limit';
import { hmacHex } from '../../cloudflare/worker/hmac';

const secret = 'test-only-already-shared-owner-key';
const signed = async (key: string, at = Date.now(), signingKey = secret) => new Request(`https://platform${AUTH_LIMIT_PATH}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-yoneda-auth-limit': await hmacHex(signingKey, `yoneda:placed-auth-limit:v1\n${at}\n${key}`) },
  body: JSON.stringify({ key, at }),
});

it('spends only a verified fresh key and never treats a signature as an operator bearer', async () => {
  const seen: string[] = [];
  const env = { OWNER_TOKEN: secret, AUTH_LIMITER: { limit: async ({ key }: { key: string }) => { seen.push(key); return { success: true }; } } };
  const platform = { fetch: (req: Request) => authLimitResponse(req, env) } as unknown as Fetcher;
  expect(await placedAuthLimit(platform, secret, 'oauth:client')).toEqual({ success: true });
  expect(seen).toEqual(['oauth:client']);
  const unsigned = new Request(`https://platform${AUTH_LIMIT_PATH}`, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ key: 'other', at: Date.now() }) });
  expect((await authLimitResponse(unsigned, env)).status).toBe(401);
  const wrongPurpose = await signed('other');
  wrongPurpose.headers.set('x-yoneda-auth-limit', await hmacHex(secret, 'other-purpose'));
  const altered = await signed('signed-key');
  const tampered = new Request(altered, { body: JSON.stringify({ key: 'other-key', at: Date.now() }) });
  for (const req of [await signed('other', Date.now(), 'wrong-key'), await signed('other', Date.now() - 60_001), await signed('other', Date.now() + 120_000), wrongPurpose, tampered, await signed(''), await signed('x'.repeat(257))])
    expect((await authLimitResponse(req, env)).status).toBe(401);
  expect(seen).toEqual(['oauth:client']);
});

it('bounds malformed authenticated bodies and fails closed on absent configuration or backend errors', async () => {
  let spent = 0;
  const env = { OWNER_TOKEN: secret, AUTH_LIMITER: { limit: async () => { spent++; return { success: true }; } } };
  for (const body of ['{', JSON.stringify({ key: 'x'.repeat(2048), at: Date.now() })]) {
    const req = new Request(`https://platform${AUTH_LIMIT_PATH}`, { method: 'POST', headers: { 'x-yoneda-auth-limit': 'a'.repeat(64) }, body });
    expect((await authLimitResponse(req, env)).status).toBe(400);
  }
  expect((await authLimitResponse(await signed('x'), { OWNER_TOKEN: secret })).status).toBe(503);
  expect((await authLimitResponse(await signed('x'), { AUTH_LIMITER: env.AUTH_LIMITER })).status).toBe(401);
  const platform = { fetch: async () => new Response(null, { status: 401 }) } as unknown as Fetcher;
  await expect(placedAuthLimit(platform, secret, 'x')).rejects.toThrow('unavailable');
  await expect(placedAuthLimit(platform, undefined, 'x')).rejects.toThrow('not configured');
  expect(spent).toBe(0);
});
