import { describe, expect, it } from 'vitest';
import { cellOfRequest, frontEnv, toCell } from '../../cloudflare/worker/cell-edge';
import { HOME_COOKIE } from '../../cloudflare/worker/cell-names';
import { askCell } from '../../cloudflare/worker/cell-route';
import { carriedRequest, inScope } from '../../cloudflare/worker/request-scope';
import type { Env } from '../../cloudflare/worker/types';
import { bindings } from './repo-fixture';

const echo = (bindings as unknown as { GEOGRAPHY_ECHO: Fetcher }).GEOGRAPHY_ECHO;
const env = { CELLS: 'on', AUTOMATIC_LOCALITY: 'on', PLATFORM: echo, CELL_WEUR: echo } as Env;
const request = (path = '/api/v1/repos') => new Request(`https://yoneda${path}`, {
  method: 'POST', body: JSON.stringify({ name: 'example' }),
  headers: { 'content-type': 'application/json', cookie: `${HOME_COOKIE}=enam`, authorization: 'Bearer ypat_legacy-token' },
  cf: { continent: 'EU', colo: 'FRA' },
});

describe('actual visitor location through edge and internal service hops', () => {
  it('keeps front auth allowances on one placed backend across edge instances', async () => {
    const keys: string[] = [];
    const platform = {
      fetch: async (req: Request) => {
        expect(new URL(req.url).pathname).toBe('/internal/auth-limit');
        expect(req.method).toBe('POST');
        expect(req.headers.get('x-yoneda-auth-limit')).toMatch(/^[a-f0-9]{64}$/);
        expect(req.headers.get('authorization')).toBeNull();
        const value = await req.json<any>();
        keys.push(value.key);
        return Response.json({ success: keys.length <= 1 });
      },
      authLimit: async () => { throw new Error('RPC is not affected by placement'); },
    } as unknown as Fetcher;
    const local = { limit: async () => { throw new Error('edge-local allowance must not be used'); } };
    const a = frontEnv({ ...env, PLATFORM: platform, AUTH_LIMITER: local, OWNER_TOKEN: 'test-shared-secret' });
    const b = frontEnv({ ...env, PLATFORM: platform, AUTH_LIMITER: local, OWNER_TOKEN: 'test-shared-secret' });
    expect(await a.AUTH_LIMITER?.limit({ key: 'oauth:example' })).toEqual({ success: true });
    expect(await b.AUTH_LIMITER?.limit({ key: 'oauth:example' })).toEqual({ success: false });
    expect(keys).toEqual(['oauth:example', 'oauth:example']);
  });
  it('selects the current location before an older home cookie or token for creates and imports', async () => {
    for (const path of ['/api/v1/repos', '/api/v1/repos/import']) {
      const req = request(path);
      expect(await cellOfRequest(req, env, new URL(req.url))).toBe('weur');
    }
  });

  it('keeps existing IDs and account requests at their authority/home', async () => {
    for (const path of ['/api/v1/repos/r0123456789abcdef0123/fork', '/api/v1/repos/r0123456789abcdef0123/objects', '/api/v1/tokens']) {
      const req = request(path);
      expect(await cellOfRequest(req, env, new URL(req.url))).toBe('enam');
    }
  });

  it('does not treat forged HTTP hints or missing metadata as a current location', async () => {
    const req = new Request('https://yoneda/api/v1/repos', { method: 'POST', headers: { cookie: `${HOME_COOKIE}=enam`, 'cf-ipcountry': 'DE', 'x-yoneda-region': 'weur' } });
    expect(await cellOfRequest(req, env, new URL(req.url))).toBe('enam');
  });

  it('preserves actual cf metadata across Request cloning and the first real service binding', async () => {
    const req = request();
    const result = await inScope({ env: { REQUEST_IDS: 'on' }, req }, () => toCell(carriedRequest(req), env));
    expect(await result.json()).toMatchObject({ continent: 'EU', colo: 'FRA', body: { name: 'example' } });
  });

  it('preserves actual cf metadata on a rebuilt internal request after its input body was consumed', async () => {
    const req = request();
    await req.json();
    const result = await inScope({ env, req }, () => askCell(env, 'weur', '/api/v1/repos', { method: 'POST', body: JSON.stringify({ name: 'forwarded' }) }));
    expect(result).toMatchObject({ continent: 'EU', colo: 'FRA', body: { name: 'forwarded' } });
  });
});
