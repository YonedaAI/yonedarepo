// Chained route integration over real account authorities and D1 in workerd.
// Fetcher adapters model service boundaries, not physical provider placement.
import { describe, expect, it } from 'vitest';
import { edgeFetch } from '../../cloudflare/worker/cell-edge';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { inScope } from '../../cloudflare/worker/request-scope';
import type { Env } from '../../cloudflare/worker/types';
import { bindings, scoped, usePlatformFixture } from './repo-fixture';
import { applySchema } from './repo-fixture-schema';

usePlatformFixture();
const europeIndex = (bindings as unknown as { INDEX_WEUR: D1Database }).INDEX_WEUR;
function topology() {
  const visits: string[] = [];
  const service = (label: string, target: () => Env, edge = false) => ({
    fetch(req: Request) {
      visits.push(label);
      const env = target();
      return inScope({ env, req }, () => edge ? edgeFetch(req, env) : platformFetch(req, env));
    },
    // These cases exercise request state, not email delivery/projection jobs.
    accountCreated: async () => {},
  }) as unknown as Fetcher;
  const common = { ...scoped, CELLS: 'on', REGIONAL_API: 'on', REGION_SIGNALS: 'on' };
  const enam: Env = { ...common, API_REGION: 'enam' };
  const apac: Env = { ...common, API_REGION: 'apac' };
  const euApi: Env = { ...common, API_REGION: 'weur' };
  const euAuthority: Env = { ...common, CELL: 'weur', API_REGION: 'weur', INDEX: europeIndex };
  const entry: Env = { ...common };
  const targets = {
    API_ENAM: service('api-enam', () => enam),
    API_APAC: service('api-apac', () => apac),
    API_WEUR: service('api-weur', () => euApi),
    CELL_ENAM: service('authority-enam', () => enam),
    CELL_WEUR: service('authority-weur', () => euAuthority),
  };
  for (const env of [enam, apac, euApi, euAuthority, entry]) {
    Object.assign(env, targets);
    env.SELF = service('self', () => env);
  }
  return { entry: service('entry', () => entry, true), euAuthority: targets.CELL_WEUR, visits,
    miswireEuToEntry() {
      apac.CELL_WEUR = { fetch(req: Request) {
        visits.push('wrong-entry');
        // Bound a pre-fix loop in the reproduction instead of leaving it running.
        if (visits.filter(v => v === 'wrong-entry').length > 1)
          return Promise.resolve(Response.json({ error: { code: 'LOOP', message: 'Unexpected redispatch' } }, { status: 500 }));
        return inScope({ env: entry, req }, () => edgeFetch(req, entry));
      } } as Fetcher;
    },
  };
}
function request(continent: string, path: string, body?: object, cookie?: string) {
  const req = new Request(`https://yoneda${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  Object.defineProperty(req, 'cf', { value: { continent, colo: 'SJO' } });
  return req;
}
async function signup(client: Fetcher, continent: string, name: string) {
  const res = await client.fetch(request(continent, '/api/auth/signup', {
    email: `${name}@example.com`, password: 'long platform test password',
  }));
  expect(res.status).toBe(200);
  return res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}

describe('entry, regional execution and authority forwarding', () => {
  it('preserves APAC selection and EU serving identity after real account-home admission', async () => {
    await applySchema(europeIndex);
    const { entry, visits } = topology();
    const cookie = await signup(entry, 'EU', 'europe-person');
    expect(visits).toEqual(['entry', 'api-weur', 'authority-weur']);
    visits.length = 0;
    const res = await entry.fetch(request('AS', '/api/v1/repos', undefined, cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-yoneda-entry-region')).toBe('apac');
    expect(res.headers.get('x-yoneda-api-region')).toBe('weur');
    expect(visits).toEqual(['entry', 'api-apac', 'authority-weur']);
  });

  it('forwards an opposite-cell account to the non-dispatching default authority', async () => {
    await applySchema(europeIndex);
    const { entry, euAuthority, visits } = topology();
    const cookie = await signup(entry, 'NA', 'north-person');
    visits.length = 0;
    const res = await euAuthority.fetch(request('NA', '/api/v1/repos', undefined, cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-yoneda-api-region')).toBe('enam');
    expect(visits).toEqual(['authority-weur', 'authority-enam']);
  });

  it('serves a default-home account on its selected APAC execution adapter', async () => {
    const { entry, visits } = topology();
    const cookie = await signup(entry, 'NA', 'travelling-person');
    visits.length = 0;
    const res = await entry.fetch(request('AS', '/api/v1/repos', undefined, cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-yoneda-entry-region')).toBe('apac');
    expect(res.headers.get('x-yoneda-api-region')).toBe('apac');
    expect(visits).toEqual(['entry', 'api-apac']);
  });

  it('carries the refusal-only marker across reconstructed create forwarding', async () => {
    const { entry, visits, miswireEuToEntry } = topology();
    const cookie = await signup(entry, 'NA', 'forwarding-person');
    miswireEuToEntry(); visits.length = 0;
    const res = await entry.fetch(request('AS', '/api/v1/repos', { name: 'routing-fixture', region: 'weur' }, cookie));
    expect(res.status).toBe(503);
    expect(visits).toEqual(['entry', 'api-apac', 'wrong-entry']);
  });
});
