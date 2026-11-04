// Routing contract tests in workerd. Binding doubles record the forwarded Request;
// physical placement and provider bindings require separate live deployment receipts.
import { describe, expect, it } from 'vitest';
import { edgeFetch, signInEnv, toCell } from '../../cloudflare/worker/cell-edge';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { inScope } from '../../cloudflare/worker/request-scope';
import { regionalDispatch } from '../../cloudflare/worker/regional-api';
import type { Env } from '../../cloudflare/worker/types';

const pairs = [['NA', 'enam'], ['EU', 'weur'], ['AS', 'apac'], ['OC', 'oc'], ['SA', 'sam'], ['AF', 'afr']] as const;
function request(continent: string | null, path = '/api/v1/repos/r00000000000000000000', init: RequestInit = {}) {
  const req = new Request(`https://api.example.test${path}`, init);
  if (continent) Object.defineProperty(req, 'cf', { value: { continent, country: 'XX', colo: 'SJO' } });
  return req;
}
function fixture() {
  const calls: { region: string; req: Request }[] = [];
  const target = (region: string) => ({ fetch: async (req: Request) => {
    calls.push({ region, req });
    return new Response(region, { headers: { 'x-yoneda-api-region': region } });
  } }) as Fetcher;
  const env = { CELLS: 'on', REGIONAL_API: 'on', CELL_ENAM: target('legacy-enam'), CELL_WEUR: target('legacy-weur'),
    PLATFORM: target('legacy-platform'), ...Object.fromEntries(pairs.map(([, region]) => [`API_${region.toUpperCase()}`, target(region)])),
  } as unknown as Env;
  return { env, calls };
}
const scoped = (env: Env, req: Request, run: () => Promise<Response>) => inScope({ env, req }, run);

describe('explicit caller-based API routing', () => {
  it.each(pairs)('routes trusted %s requests to %s before authority selection', async (continent, region) => {
    const { env, calls } = fixture();
    const req = request(continent);
    const response = await scoped(env, req, () => toCell(req, env));
    expect(await response.text()).toBe(region);
    expect(calls.map(c => c.region)).toEqual([region]);
    expect(response.headers.get('x-yoneda-entry-region')).toBe(region);
    expect(calls[0].req.cf?.continent).toBe(continent);
  });

  it('uses trusted geography before cookies, tokens, repository tags or supplied region headers', async () => {
    const { env, calls } = fixture();
    const req = request('AS', '/api/v1/repos/r00000000000000eea001', { headers: {
      cookie: 'yoneda_home=weur', authorization: 'Bearer ypat_eu_not-a-token',
      'x-yoneda-api-region': 'weur', 'x-yoneda-entry-region': 'weur', 'cf-ipcountry': 'DE',
    } });
    await scoped(env, req, () => toCell(req, env));
    expect(calls.map(c => c.region)).toEqual(['apac']);
    expect(calls[0].req.headers.get('authorization')).toBe('Bearer ypat_eu_not-a-token');
  });

  it('refuses a missing known-region binding without sending the request elsewhere', async () => {
    const { env, calls } = fixture(); delete env.API_APAC;
    const req = request('AS');
    const response = await scoped(env, req, () => toCell(req, env));
    expect(response.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it.each([null, 'AN', 'T1', 'bad'])('uses the documented default for unknown geography %s', async continent => {
    const { env, calls } = fixture(); const req = request(continent);
    await scoped(env, req, () => toCell(req, env));
    expect(calls.map(c => c.region)).toEqual(['enam']);
  });

  it('keeps old authority routing unchanged while the switch is off', async () => {
    const { env, calls } = fixture(); env.REGIONAL_API = 'off'; const req = request('AS');
    await scoped(env, req, () => toCell(req, env));
    expect(calls.map(c => c.region)).toEqual(['legacy-enam']);
  });

  it('routes the public API entry before authentication or repository work', async () => {
    const { env, calls } = fixture(); const req = request('OC');
    const response = await scoped(env, req, () => platformFetch(req, env));
    expect(await response.text()).toBe('oc');
    expect(calls.map(c => c.region)).toEqual(['oc']);
  });

  it('routes the standalone global edge entry through the same selector', async () => {
    const { env, calls } = fixture(); const req = request('AF');
    await scoped(env, req, () => edgeFetch(req, env));
    expect(calls.map(c => c.region)).toEqual(['afr']);
  });

  it('a configured API execution worker never redispatches through regional bindings', () => {
    const { env, calls } = fixture(); env.API_REGION = 'apac';
    expect(regionalDispatch(request('AS'), env)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('refuses unexpected recursive entry bindings after one dispatch', async () => {
    const { env, calls } = fixture();
    env.API_APAC = { fetch: (req: Request) => {
      calls.push({ region: 'wrong-entry', req });
      return scoped(env, req, () => platformFetch(req, env));
    } } as Fetcher;
    const req = request('AS');
    const response = await scoped(env, req, () => toCell(req, env));
    expect(response.status).toBe(503);
    expect(calls.map(c => c.region)).toEqual(['wrong-entry']);
  });

  it('a client hop marker only refuses its request and cannot bypass entry routing', async () => {
    const { env, calls } = fixture();
    const req = request('AS', '/api/v1/repos', { headers: { 'x-yoneda-api-hop': '1' } });
    const response = await scoped(env, req, () => toCell(req, env));
    expect(response.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it('keeps European signup projection in its authority cell after entry selection', async () => {
    const { env, calls } = fixture(); env.API_REGION = 'weur';
    const req = request('EU', '/api/auth/signup', { method: 'POST', body: '{}' });
    await scoped(env, req, () => platformFetch(req, env));
    expect(calls.map(c => c.region)).toEqual(['legacy-weur']);
  });

  it.each(pairs)('starts new provider-signin authorities near original %s geography', (continent, region) => {
    const { env } = fixture(); const gets: unknown[] = [];
    env.WORKSPACES = { get: (...args: unknown[]) => { gets.push(args); return {}; } } as unknown as DurableObjectNamespace;
    const near = signInEnv(request(continent), env);
    near.WORKSPACES.get('test-id' as unknown as DurableObjectId);
    expect(gets).toEqual([['test-id', { locationHint: region }]]);
  });

  it('keeps alias health local and refuses site assets without dispatch or asset access', async () => {
    const { env, calls } = fixture(); env.API_REGION = 'oc';
    const health = request('OC', '/health');
    const healthy = await scoped(env, health, () => platformFetch(health, env));
    expect((await healthy.json<{ api_region: string }>()).api_region).toBe('oc');
    for (const path of ['/', '/explore', '/missing-asset.js']) {
      const asset = request('OC', path);
      const missing = await scoped(env, asset, () => platformFetch(asset, env));
      expect(missing.status).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it('preserves the selected and final authority-serving identities separately', async () => {
    const { env } = fixture();
    env.API_APAC = { fetch: async () => new Response('Europe-authorized content', { headers: { 'x-yoneda-api-region': 'weur' } }) } as Fetcher;
    const req = request('AS'); const response = await scoped(env, req, () => toCell(req, env));
    expect(response.headers.get('x-yoneda-entry-region')).toBe('apac');
    expect(response.headers.get('x-yoneda-api-region')).toBe('weur');
  });

  it('streams a Git upload with its original metadata and credentials', async () => {
    const { env, calls } = fixture();
    env.API_SAM = { fetch: async (req: Request) => { calls.push({ region: 'sam', req }); return new Response(req.body); } } as Fetcher;
    const req = request('SA', '/git/r00000000000000000000.git/git-receive-pack', {
      method: 'POST', headers: { authorization: 'Bearer private-test-token' }, body: 'git packet bytes',
    });
    const response = await scoped(env, req, () => toCell(req, env));
    expect(await response.text()).toBe('git packet bytes');
    expect(calls[0].req.cf?.continent).toBe('SA');
    expect(calls[0].req.headers.get('authorization')).toBe('Bearer private-test-token');
  });
});
