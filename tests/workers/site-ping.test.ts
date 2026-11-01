// The ping (`POST /api/e`): a browser that ran the page says so, which makes one Human view. It
// fails silently, sets no cookie, keeps no IP address or user agent, and takes only same-origin
// requests about pages that exist. Simulated bindings only.
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { frontFetch } from '../../cloudflare/worker/front-routes';
import type { Env } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
const ORIGIN = 'https://yonedarepo.test';
const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const manifest = {
  routes: ['/', '/pricing'].map((path) => ({
    path,
    name: path,
    title: path,
    description: path,
    kind: 'page',
    sitemap: true,
  })),
  aliases: {},
};
const platform = () =>
  vi.fn(async (req: Request) => {
    const { pathname } = new URL(req.url);
    if (pathname === '/api/v1/resolve/alice/compiler')
      return Response.json({ handle: 'alice', name: 'compiler', path: '/alice/compiler' });
    if (pathname === '/api/v1/profiles/alice') return Response.json({ handle: 'alice', repos: [] });
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  });
function site(extra: Partial<Env> = {}) {
  const points: AnalyticsEngineDataPoint[] = [];
  const limit = vi.fn(async (_: { key: string }) => ({ success: true }));
  const fetch = platform();
  const using = {
    ...bindings,
    TRAFFIC_EVENTS: 'on',
    PLATFORM: { fetch },
    AUTH_LIMITER: { limit },
    SITE_EVENTS: { writeDataPoint: vi.fn((p: AnalyticsEngineDataPoint) => points.push(p)) },
    ASSETS: {
      fetch: async (req: Request) =>
        new URL(req.url).pathname === '/_site/routes.json'
          ? Response.json(manifest)
          : new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    },
    ...extra,
  } as unknown as Env;
  return { using, points, limit, fetch };
}
const browser = {
  origin: ORIGIN,
  'user-agent': SAFARI,
  'cf-connecting-ip': '203.0.113.77',
  'content-type': 'application/json',
};
const ping = (body: unknown, headers: Record<string, string> = browser, method = 'POST') =>
  new Request(`${ORIGIN}/api/e`, {
    method,
    headers,
    cf: { country: 'DE' },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  } as RequestInit);

it('records one Human view with the path, referring site and country, and nothing about the visitor', async () => {
  const { using, points, limit } = site();
  const response = await frontFetch(ping({ path: '/pricing', referrer: 'news.ycombinator.com' }), using);
  expect(response.status).toBe(204);
  expect(response.headers.get('set-cookie')).toBe(null);
  expect(await response.text()).toBe('');
  expect(points).toEqual([
    {
      indexes: ['ping'],
      blobs: ['ping', '/pricing', 'news.ycombinator.com', 'DE', 'desktop', '', '', '', '', 'human'],
      doubles: [0, 1],
    },
  ]);
  expect(limit).toHaveBeenCalledOnce();
  const recorded = JSON.stringify(points);
  for (const secret of ['203.0.113.77', 'Safari', 'Macintosh']) expect(recorded).not.toContain(secret);
});

it('counts a signed-in reader of a public page as a Human, and keeps nothing of who', async () => {
  const { using, points, fetch } = site();
  const cookie = `yoneda_account=alice.${'a'.repeat(64)}`;
  await frontFetch(ping({ path: '/pricing' }, { ...browser, cookie }), using);
  await frontFetch(ping({ path: '/alice/compiler' }, { ...browser, cookie }), using);
  expect(points.map((p) => [p.blobs?.[1], p.blobs?.[9]])).toEqual([
    ['/pricing', 'signed_in'],
    ['/alice/compiler', 'signed_in'],
  ]);
  expect(JSON.stringify(points[0])).not.toContain('alice');
  expect(JSON.stringify(points)).not.toContain('a'.repeat(64));
  for (const [ask] of fetch.mock.calls) expect(ask.headers.has('cookie')).toBe(false);
});

it.each(['/alice/private-plans', '/settings/tokens', '/settings', '/admin/traffic', '/new'])(
  'records nothing for a signed-in reader of %s: the app and private repositories stay out',
  async (path) => {
    const { using, points } = site();
    const cookie = `yoneda_account=alice.${'a'.repeat(64)}`;
    await frontFetch(ping({ path }, { ...browser, cookie }), using);
    expect(points).toEqual([]);
  },
);

it('finds real pages behind any address: an inside page, a public repository and a profile', async () => {
  const { using, points } = site();
  for (const path of [
    '/alice/compiler',
    '/alice/compiler/tree/main/src/secret-plan.md',
    '/alice',
    '/source/explore',
  ])
    await frontFetch(ping({ path }), using);
  expect(points.map((p) => p.blobs?.[1])).toEqual([
    '/alice/compiler',
    '/alice/compiler',
    '/alice',
    '/source/explore',
  ]);
  expect(JSON.stringify(points)).not.toContain('secret');
});

it('carries the visitor address to the platform, so anonymous limits stay theirs', async () => {
  const { using, fetch } = site();
  await frontFetch(ping({ path: '/alice/compiler' }), using);
  expect(fetch.mock.calls[0][0].headers.get('cf-connecting-ip')).toBe('203.0.113.77');
  expect(fetch.mock.calls[0][0].headers.has('cookie')).toBe(false);
});

it('keeps only a referring host that is a host and not this site', async () => {
  const { using, points } = site();
  for (const referrer of ['https://evil.example/x?y=1', 'yonedarepo.test', 42, '<script>'])
    await frontFetch(ping({ path: '/pricing', referrer }), using);
  expect(points.map((p) => p.blobs?.[2])).toEqual(['', '', '', '']);
});

it.each([
  ['an unknown path', { path: '/wp' }],
  ['a private or missing repository', { path: '/alice/secret-plans' }],
  ['an unknown page inside a known section', { path: '/docs/nope' }],
  ['the signed-in app', { path: '/settings' }],
  ['another host smuggled into the path', { path: '//evil.example/pricing' }],
  ['a path that is not one', { path: 'pricing' }],
  ['a path of the wrong type', { path: 7 }],
  ['no path', {}],
  ['a body that is not JSON', 'path=/pricing'],
  ['a body over the limit', { path: '/pricing', referrer: 'x'.repeat(2048) }],
])('answers 204 and records nothing for %s', async (_what, body) => {
  const { using, points } = site();
  const response = await frontFetch(ping(body), using);
  expect(response.status).toBe(204);
  expect(points).toEqual([]);
});

it.each([
  ['another origin', { ...browser, origin: 'https://evil.example' }],
  ['no origin', { 'user-agent': SAFARI }],
  ['a cross-site fetch', { ...browser, 'sec-fetch-site': 'cross-site' }],
  ["the live tests' browser", { ...browser, 'x-yoneda-own-traffic': '1' }],
  ['an AI agent', { ...browser, 'user-agent': 'Mozilla/5.0; Claude-User/1.0' }],
  ['a crawler that runs JavaScript', { ...browser, 'user-agent': 'Googlebot/2.1' }],
  ['curl', { ...browser, 'user-agent': 'curl/8.7.1' }],
  ['Chrome without client hints', { ...browser, 'user-agent': 'Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36' }],
])('answers 204 and records nothing from %s', async (_what, headers) => {
  const { using, points } = site();
  const response = await frontFetch(ping({ path: '/pricing' }, headers), using);
  expect(response.status).toBe(204);
  expect(points).toEqual([]);
});

it('takes POST only', async () => {
  const { using, points } = site();
  expect((await frontFetch(ping({}, browser, 'GET'), using)).status).toBe(204);
  expect(points).toEqual([]);
});

it('stops at the limiter, before reading anything else', async () => {
  const { using, points, fetch } = site({
    AUTH_LIMITER: { limit: async () => ({ success: false }) } as unknown as Env['AUTH_LIMITER'],
  });
  expect((await frontFetch(ping({ path: '/alice/compiler' }), using)).status).toBe(204);
  expect(points).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it('fails silently: the switch off, no binding, or every dependency throwing', async () => {
  const off = site({ TRAFFIC_EVENTS: 'off' });
  expect((await frontFetch(ping({ path: '/pricing' }), off.using)).status).toBe(204);
  expect(off.points).toEqual([]);
  expect(off.limit).not.toHaveBeenCalled();
  const unbound = site({ SITE_EVENTS: undefined });
  expect((await frontFetch(ping({ path: '/pricing' }), unbound.using)).status).toBe(204);
  const broken = site({
    AUTH_LIMITER: {
      limit: async () => {
        throw new Error('limiter down');
      },
    } as unknown as Env['AUTH_LIMITER'],
    PLATFORM: {
      fetch: async () => {
        throw new Error('platform down');
      },
    } as unknown as Fetcher,
    SITE_EVENTS: {
      writeDataPoint: () => {
        throw new Error('dataset down');
      },
    },
  });
  expect((await frontFetch(ping({ path: '/alice/compiler' }), broken.using)).status).toBe(204);
});
