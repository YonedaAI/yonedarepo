// `POST /api/client-error`: what a broken page reports, and everything it may not.
import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { clientError, routeOf } from '../../cloudflare/worker/client-errors';
import { frontFetch } from '../../cloudflare/worker/front-routes';
import type { Env } from '../../cloudflare/worker/types';

const ORIGIN = 'https://yoneda.test';
const BROWSER = {
  origin: ORIGIN,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-ch-ua': '"Chromium";v="130"',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/130.0 Safari/537.36',
  'accept-language': 'en',
  accept: '*/*',
  'content-type': 'application/json',
};
const allowed = { limit: vi.fn(async () => ({ success: true })) };
const on = { ...(env as unknown as Env), CLIENT_ERRORS: 'on', AUTH_LIMITER: allowed } as unknown as Env;
const report = (body: unknown, headers: Record<string, string> = BROWSER, method = 'POST') =>
  new Request(`${ORIGIN}/api/client-error`, { method, headers, body: JSON.stringify(body) });
const fine = { message: 'Cannot read properties of undefined', route: '/ada/secret-plans/blob/main/plan.md' };

afterEach(() => vi.restoreAllMocks());

const logged = () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => spy.mock.calls.map(([line]) => JSON.parse(String(line)));
};

it('logs a message and a route, and nothing that names a repository or a file', async () => {
  const lines = logged();
  const res = await frontFetch(report(fine), on);
  expect(res.status).toBe(204);
  expect(await res.text()).toBe('');
  expect(lines()).toEqual([
    { event: 'client.error', level: 'error', message: fine.message, route: '/:owner/:repo/blob' },
  ]);
  expect(JSON.stringify(lines())).not.toContain('secret-plans');
});

it.each([
  ['the switch off', () => clientError(report(fine), { ...on, CLIENT_ERRORS: 'off' } as Env)],
  ['the wrong method', () => clientError(new Request(`${ORIGIN}/api/client-error`, { headers: BROWSER }), on)],
  ['another origin', () => clientError(report(fine, { ...BROWSER, origin: 'https://evil.test' }), on)],
  ['a cross-site fetch', () => clientError(report(fine, { ...BROWSER, 'sec-fetch-site': 'cross-site' }), on)],
  ['a script', () => clientError(report(fine, { origin: ORIGIN, 'user-agent': 'curl/8.0' }), on)],
  ['no message', () => clientError(report({ route: '/' }), on)],
  ['a message that is not text', () => clientError(report({ message: { html: '<div>' }, route: '/' }), on)],
  ['a route that is a URL', () => clientError(report({ ...fine, route: 'https://evil.test/' }), on)],
  ['a body over the limit', () => clientError(report({ ...fine, message: 'x'.repeat(3000) }), on)],
  ['a body that is not JSON', () => clientError(new Request(`${ORIGIN}/api/client-error`, { method: 'POST', headers: BROWSER, body: '{' }), on)],
])('refuses %s, silently', async (_name, send) => {
  const lines = logged();
  const res = await send();
  expect(res.status).toBe(204);
  expect(lines()).toEqual([]);
});

it('stops at the rate limit, counted per address', async () => {
  const lines = logged();
  const limit = vi.fn(async () => ({ success: false }));
  await clientError(report(fine, { ...BROWSER, 'cf-connecting-ip': '192.0.2.7' }), { ...on, AUTH_LIMITER: { limit } } as unknown as Env);
  expect(limit).toHaveBeenCalledWith({ key: 'client-error:192.0.2.7' });
  expect(lines()).toEqual([]);
});

it('bounds and scrubs what a page says', async () => {
  const lines = logged();
  await clientError(report({ route: '/', message: `token=abc123 for ada@example.com ${'x '.repeat(600)}` }), on);
  const [line] = lines();
  expect(line.message.length).toBeLessThanOrEqual(300);
  expect(line.message).not.toContain('abc123');
  expect(line.message).not.toContain('ada@example.com');
});

it.each([
  ['/', '/'],
  ['/settings/tokens', '/settings/tokens'],
  ['/admin/accounts/some-account-id/9', '/admin/accounts'],
  ['/source/r0123456789abcdef0123', '/source'],
  ['/ada', '/:owner'],
  ['/ada/plans', '/:owner/:repo'],
  ['/ada/plans/tree/main/secret', '/:owner/:repo/tree'],
])('keeps the shape of %s', (path, route) => {
  expect(routeOf(path)).toBe(route);
});
