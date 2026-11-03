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
  it('shares one durable allowance across edge instances and regional account hints', async () => {
    const local = { limit: async () => { throw new Error('edge-local counter must not be used'); } };
    const common = { ...env, WORKSPACES: bindings.WORKSPACES, GLOBAL_AUTH_LIMITS: 'on', AUTH_LIMITER: local, OWNER_TOKEN: 'test-shared-secret' };
    const a = frontEnv(common);
    const b = frontEnv({ ...common, CELL: 'weur', AUTH_LIMITER: undefined });
    const key = `oauth:global-${crypto.randomUUID()}`;
    for (let n = 0; n < 30; n++)
      expect(await (n % 2 ? a : b).AUTH_LIMITER?.limit({ key })).toEqual({ success: true });
    expect(await a.AUTH_LIMITER?.limit({ key })).toEqual({ success: false });
    expect(await b.AUTH_LIMITER?.limit({ key })).toEqual({ success: false });
    expect(await b.AUTH_LIMITER?.limit({ key: `${key}-other` })).toEqual({ success: true });
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

it('leaves readable name resolution to the API without a duplicate edge directory read', async () => {
  let reads = 0;
  const noDirectory = { idFromName() { reads++; throw new Error('edge must not resolve the directory'); } } as unknown as DurableObjectNamespace;
  for (const path of ['/api/v1/resolve/owner/project', '/owner/project.git/info/refs?service=git-upload-pack']) {
    const req = new Request(`https://yoneda${path}`, { cf: { continent: 'EU', colo: 'FRA' } });
    const response = await toCell(req, { ...env, WORKSPACES: noDirectory });
    expect(response.status).toBe(200);
  }
  expect(reads).toBe(0);
});
