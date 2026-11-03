// Real WorkspaceAuthority counters under workerd; no provider, IP or account fixtures.
import { env } from 'cloudflare:workers';
import { afterEach, expect, it } from 'vitest';
import { reset } from 'cloudflare:test';
import { AUTH_LIMIT_PATH } from '../../cloudflare/worker/auth-limit';
import { frontEnv } from '../../cloudflare/worker/cell-edge';
import { hmacHex } from '../../cloudflare/worker/hmac';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';

const secret = 'test-only-global-auth-compat-key';
const regions = [undefined, 'enam', 'weur', 'apac', 'oc', 'sam', 'afr'];
const signed = async (key: string, at = Date.now(), signingKey = secret) =>
  new Request(`https://platform${AUTH_LIMIT_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-yoneda-auth-limit': await hmacHex(
        signingKey,
        `yoneda:placed-auth-limit:v1\n${at}\n${key}`,
      ),
    },
    body: JSON.stringify({ key, at }),
  });
const fixture = () => {
  let nativeCalls = 0;
  const common = {
    ...env,
    OWNER_TOKEN: secret,
    GLOBAL_AUTH_LIMITS: 'on',
    REGIONAL_API: 'on',
    AUTH_LIMITER: {
      limit: async () => {
        nativeCalls++;
        return { success: true };
      },
    },
  } as unknown as Env;
  return { common, nativeCalls: () => nativeCalls };
};
const spend = async (key: string, target: Env) => {
  const answer = await platformFetch(await signed(key), target);
  expect(answer.status).toBe(200);
  return answer.json<{ success: boolean }>();
};
afterEach(() => reset());

it('shares compatibility requests across entry/alias identities and the current frontend counter', async () => {
  const { common, nativeCalls } = fixture();
  const targets = regions.map((API_REGION) => ({ ...common, API_REGION }));
  const modern = frontEnv(common).AUTH_LIMITER!;
  const key = `oauth:compat-${crypto.randomUUID()}`;
  for (let n = 0; n < 30; n++) {
    const result =
      n % 4 === 0 ? await modern.limit({ key }) : await spend(key, targets[n % targets.length]);
    expect(result).toEqual({ success: true });
  }
  for (const target of targets) expect(await spend(key, target)).toEqual({ success: false });
  expect(await modern.limit({ key })).toEqual({ success: false });
  expect(await spend(`${key}-another`, targets[2])).toEqual({ success: true });
  expect(nativeCalls()).toBe(0);
});

it('refuses invalid compatibility proofs without spending either counter', async () => {
  const { common, nativeCalls } = fixture();
  const key = `oauth:refused-${crypto.randomUUID()}`;
  const target = { ...common, API_REGION: 'weur' };
  const unsigned = new Request(`https://platform${AUTH_LIMIT_PATH}`, {
    method: 'POST',
    body: '{}',
  });
  const altered = await signed('original');
  const tampered = new Request(altered, { body: JSON.stringify({ key, at: Date.now() }) });
  for (const req of [
    unsigned,
    await signed(key, Date.now(), 'wrong-key'),
    await signed(key, Date.now() - 120_000),
    tampered,
  ])
    expect((await platformFetch(req, target)).status).toBe(401);
  for (let n = 0; n < 30; n++) expect(await spend(key, target)).toEqual({ success: true });
  expect(await spend(key, target)).toEqual({ success: false });
  expect(nativeCalls()).toBe(0);
});

it('keeps the native compatibility limiter when global counters are off', async () => {
  const { common, nativeCalls } = fixture();
  const target = {
    ...common,
    GLOBAL_AUTH_LIMITS: 'off',
    WORKSPACES: undefined,
    API_REGION: 'apac',
  } as unknown as Env;
  expect(await spend(`oauth:local-${crypto.randomUUID()}`, target)).toEqual({ success: true });
  expect(nativeCalls()).toBe(1);
});
