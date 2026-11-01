// Platform requests by client kind (admin Traffic page): one sampled data point, written without
// waiting, holding the client kind, country and operation class and never a repository, account,
// token or address. It can't change a response. Simulated bindings only.
import { expect, it, vi } from 'vitest';
import { clientRequest, recordClient } from '../../cloudflare/worker/platform-client-events';
import type { Env } from '../../cloudflare/worker/types';

const REPO = 'r0123456789abcdef0123';
const HOST = 'https://api.yonedarepo.test';
const ok = new Response('{}');
const ask = (path: string, init: RequestInit = {}) =>
  new Request(`${HOST}${path}`, { cf: { country: 'DE' }, ...init } as RequestInit);
const token = { authorization: 'Bearer yrt_private_token_value' };
const cli = { 'user-agent': 'yoneda-cli/0.4.0', ...token };
function bound(extra: Partial<Env> = {}) {
  const points: AnalyticsEngineDataPoint[] = [];
  const env = {
    TRAFFIC_EVENTS: 'on',
    SITE_EVENTS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) },
    ...extra,
  } as unknown as Env;
  return { env, points };
}

it.each([
  [`/git/${REPO}.git/git-upload-pack`, 'POST', {}, 'git', 'clone'],
  [`/git/${REPO}.git/git-receive-pack`, 'POST', token, 'git', 'push'],
  ['/alice/compiler.git/git-upload-pack', 'POST', {}, 'git', 'clone'],
  ['/alice/compiler.git/git-receive-pack', 'POST', token, 'git', 'push'],
  [`/git/${REPO}.git/info/lfs/objects/batch`, 'POST', token, 'git', 'write'],
  ['/api/v1/mcp', 'POST', token, 'mcp', 'mcp'],
  [`/api/v1/repos/${REPO}/mcp`, 'POST', token, 'mcp', 'mcp'],
  [`/api/v1/repos/${REPO}/land`, 'POST', cli, 'cli', 'land'],
  [`/api/v1/repos/${REPO}/commits`, 'POST', cli, 'cli', 'write'],
  [`/api/v1/repos/${REPO}/refs`, 'GET', cli, 'cli', 'read'],
  [`/api/v1/repos/${REPO}/land`, 'POST', token, 'token', 'land'],
  [`/api/v1/repos/${REPO}/refs`, 'GET', token, 'token', 'read'],
  [`/api/v1/repos/${REPO}/refs`, 'DELETE', token, 'token', 'write'],
])('sorts %s %s', (path, method, headers, client, operation) => {
  const req = ask(path, { method, headers });
  expect(clientRequest(req, new URL(req.url))).toEqual({ client, operation });
});

it.each([
  ['a browser session', `/api/v1/repos/${REPO}/refs`, { cookie: 'yoneda_account=alice.x' }],
  ['an anonymous API read', `/api/v1/repos/${REPO}/refs`, {}],
  ["Git's reference listing, which precedes the operation", `/git/${REPO}.git/info/refs`, {}],
  ['health', '/health', token],
  ['the SSH gateway', '/internal/ssh/lookup', token],
  ['sign-in', '/api/auth/session', token],
  ['the web app', '/source/explore', {}],
])('leaves out %s', (_what, path, headers) => {
  const req = ask(path, { headers });
  expect(clientRequest(req, new URL(req.url))).toBe(null);
});

it('stores the client kind, country, operation and token flag, and nothing that names anyone', () => {
  const { env, points } = bound();
  const req = ask(`/api/v1/repos/${REPO}/land`, {
    method: 'POST',
    headers: { ...cli, 'cf-connecting-ip': '203.0.113.77' },
  });
  recordClient(req, ok, env);
  expect(points).toEqual([
    {
      indexes: ['client'],
      blobs: ['client', '', '', 'DE', '', '', '', '', '', 'agent', 'cli', 'land'],
      doubles: [0, 1, 1, 1, 1],
    },
  ]);
  const recorded = JSON.stringify(points);
  for (const secret of [REPO, 'yrt_private', '203.0.113.77', 'yoneda-cli']) expect(recorded).not.toContain(secret);
});

it('says a token held only when the platform accepted it', () => {
  const { env, points } = bound();
  const req = () => ask(`/git/${REPO}.git/git-receive-pack`, { method: 'POST', headers: token });
  recordClient(req(), new Response('{}', { status: 401 }), env);
  recordClient(req(), new Response('{}', { status: 403 }), env);
  recordClient(req(), new Response('{}', { status: 404 }), env);
  recordClient(ask(`/git/${REPO}.git/git-upload-pack`, { method: 'POST' }), ok, env);
  expect(points.map((p) => p.doubles?.[3])).toEqual([0, 0, 1, 0]);
});

it('samples reads one in ten and weighs what it keeps; every other operation is kept', () => {
  const { env, points } = bound();
  const read = () => ask(`/api/v1/repos/${REPO}/refs`, { headers: token });
  recordClient(read(), ok, env, () => 0.05);
  recordClient(read(), ok, env, () => 0.5);
  expect(points.map((p) => p.doubles?.[2])).toEqual([10]);
  const land = ask(`/api/v1/repos/${REPO}/land`, { method: 'POST', headers: token });
  recordClient(land, ok, env, () => 0.99);
  expect(points.map((p) => p.doubles?.[2])).toEqual([10, 1]);
});

it('does nothing with the switch off, without the binding, or for our own tests', () => {
  const req = () => ask(`/api/v1/repos/${REPO}/land`, { method: 'POST', headers: token });
  for (const value of [undefined, 'off']) {
    const { env, points } = bound({ TRAFFIC_EVENTS: value });
    recordClient(req(), ok, env);
    expect(points).toEqual([]);
  }
  expect(() => recordClient(req(), ok, bound({ SITE_EVENTS: undefined }).env)).not.toThrow();
  const { env, points } = bound();
  recordClient(
    ask(`/api/v1/repos/${REPO}/land`, {
      method: 'POST',
      headers: { ...token, 'x-yoneda-own-traffic': '1' },
    }),
    ok,
    env,
  );
  expect(points).toEqual([]);
});

it('cannot fail a request', () => {
  const { env } = bound({
    SITE_EVENTS: {
      writeDataPoint: vi.fn(() => {
        throw new Error('dataset down');
      }),
    } as unknown as AnalyticsEngineDataset,
  });
  const req = ask(`/api/v1/repos/${REPO}/land`, { method: 'POST', headers: token });
  expect(() => recordClient(req, ok, env)).not.toThrow();
});

it('stays inside its CPU budget of 50 microseconds a request', () => {
  const { env } = bound({ SITE_EVENTS: { writeDataPoint: () => {} } as AnalyticsEngineDataset });
  const req = ask(`/api/v1/repos/${REPO}/land`, { method: 'POST', headers: token });
  const runs = 20_000;
  const start = performance.now();
  for (let i = 0; i < runs; i++) recordClient(req, ok, env);
  expect(((performance.now() - start) * 1000) / runs).toBeLessThan(50);
});
