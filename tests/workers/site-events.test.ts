// Cookieless site analytics on the front Worker: one Analytics Engine point per public HTML
// page view and per sign-up, never an IP address, cookie or visitor id, and the Cloudflare Web
// Analytics beacon on public pages only when its token is configured. Simulated bindings only.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { frontFetch } from '../../cloudflare/worker/front-routes';
import {
  readSignupSource,
  takeSignupSource,
  withSignupSource,
} from '../../cloudflare/worker/site-events';
import type { Env } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
afterEach(async () => {
  await reset();
});

const page = '<!doctype html><html><head><title>YonedaRepo</title></head><body></body></html>';
function site(extra: Partial<Env> = {}) {
  const points: AnalyticsEngineDataPoint[] = [];
  const using = {
    ...bindings,
    PLATFORM: undefined,
    SITE_EVENTS: { writeDataPoint: vi.fn((p: AnalyticsEngineDataPoint) => points.push(p)) },
    ASSETS: {
      fetch: async (req: Request) =>
        new URL(req.url).pathname.startsWith('/assets/')
          ? new Response('export {}', { headers: { 'content-type': 'text/javascript' } })
          : new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    },
    ...extra,
  } as unknown as Env;
  return { using, points };
}
const visitor = {
  'cf-connecting-ip': '203.0.113.77',
  'x-forwarded-for': '203.0.113.77',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  accept: 'text/html,application/xhtml+xml',
  referer: 'https://news.ycombinator.com/item?id=4242',
};
const get = (path: string, headers: Record<string, string> = visitor, init: RequestInit = {}) =>
  new Request(`https://yonedarepo.test${path}`, {
    headers,
    cf: { country: 'DE' },
    ...init,
  } as RequestInit);

it('records one point for a public page view: path, referring site, country, device and campaign', async () => {
  const { using, points } = site();
  const response = await frontFetch(
    get('/pricing?utm_source=hn&utm_medium=social&utm_campaign=launch&email=x@example.com'),
    using,
  );
  expect(response.status).toBe(200);
  expect(points).toHaveLength(1);
  expect(points[0]).toEqual({
    indexes: ['pageview'],
    blobs: [
      'pageview',
      '/pricing',
      'news.ycombinator.com',
      'DE',
      'desktop',
      'hn',
      'social',
      'launch',
      '',
    ],
    doubles: [0],
  });
  const recorded = JSON.stringify(points);
  for (const secret of ['203.0.113.77', 'x@example.com', 'item?id', 'Safari']) expect(recorded).not.toContain(secret);
});

it('records nothing for the API, static assets, signed-in requests, non-GET or a missing binding', async () => {
  const { using, points } = site();
  await frontFetch(get('/api/unknown'), using);
  await frontFetch(get('/assets/index-abc123.js'), using);
  await frontFetch(get('/favicon.svg'), using);
  await frontFetch(get('/pricing', { ...visitor, cookie: `yoneda_account=alice.${'a'.repeat(64)}` }), using);
  await frontFetch(get('/pricing', visitor, { method: 'POST' }), using);
  await frontFetch(get('/settings'), using);
  expect(points).toEqual([]);
  const unbound = await frontFetch(get('/pricing'), { ...using, SITE_EVENTS: undefined });
  expect(unbound.status).toBe(200);
});

it('keeps repository pages at owner/name, drops its own host as a referrer and flags bots', async () => {
  const { using, points } = site();
  await frontFetch(
    get('/alice/compiler/tree/main/src/secret-plan.md', {
      ...visitor,
      referer: 'https://yonedarepo.test/explore',
    }),
    using,
  );
  await frontFetch(
    get('/docs/guides/sessions', {
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    }),
    using,
  );
  await frontFetch(
    get('/blog', {
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    }),
    using,
  );
  expect(points.map((p) => p.blobs?.slice(1, 5))).toEqual([
    ['/alice/compiler', '', 'DE', 'desktop'],
    ['/docs/guides/sessions', '', 'DE', 'bot'],
    ['/blog', '', 'DE', 'mobile'],
  ]);
  expect(points.map((p) => p.doubles)).toEqual([[0], [1], [0]]);
});

it('a writer failure never breaks the page', async () => {
  const { using } = site({
    SITE_EVENTS: {
      writeDataPoint: () => {
        throw new Error('dataset unavailable');
      },
    },
  });
  const response = await frontFetch(get('/pricing'), using);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('<title>YonedaRepo</title>');
});

const token = '0123456789abcdef0123456789abcdef';
it('adds the Web Analytics beacon to public pages only when its token is set', async () => {
  const beacon = 'https://static.cloudflareinsights.com/beacon.min.js';
  const on = site({ WEB_ANALYTICS_TOKEN: token }).using;
  const html = await (await frontFetch(get('/pricing'), on)).text();
  expect(html).toContain(beacon);
  expect(html).toContain(`data-cf-beacon='{"token":"${token}"}'`);
  expect(html.indexOf(beacon)).toBeLessThan(html.indexOf('</head>'));
  for (const off of [
    site().using,
    site({ WEB_ANALYTICS_TOKEN: '' }).using,
    site({ WEB_ANALYTICS_TOKEN: `${token}"><script>alert(1)</script>` }).using,
  ])
    expect(await (await frontFetch(get('/pricing'), off)).text()).not.toContain(beacon);
  const signedIn = await frontFetch(
    get('/pricing', { ...visitor, cookie: `yoneda_account=alice.${'a'.repeat(64)}` }),
    on,
  );
  expect(await signedIn.text()).not.toContain(beacon);
  const script = await frontFetch(get('/assets/index-abc123.js'), on);
  expect(await script.text()).toBe('export {}');
});

it('records an email sign-up with its landing source, never the account or address', async () => {
  const { using, points } = site();
  const response = await frontFetch(
    new Request('https://yonedarepo.test/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...visitor },
      cf: { country: 'FR' },
      body: JSON.stringify({
        email: 'carol@example.com',
        password: 'a long test password',
        source: { ref: 'News.YCombinator.com', utm_source: 'hn', utm_campaign: 'x'.repeat(300) },
      }),
    } as RequestInit),
    using,
  );
  expect(response.status).toBe(200);
  expect(points).toEqual([
    {
      indexes: ['signup'],
      blobs: ['signup', '', 'news.ycombinator.com', 'FR', 'desktop', 'hn', '', 'x'.repeat(64), 'email'],
      doubles: [0],
    },
  ]);
  expect(JSON.stringify(points)).not.toContain('carol');
});

it('validates sign-up sources as untrusted input and carries them through a return path', () => {
  expect(
    readSignupSource(
      new URLSearchParams({
        ref: 'https://evil.example/path',
        utm_source: 'a\u0000b<c>',
        utm_medium: ' ads ',
      }),
    ),
  ).toEqual({ ref: '', utm_source: 'abc', utm_medium: 'ads', utm_campaign: '' });
  expect(readSignupSource({ ref: 42, utm_source: ['x'] })).toEqual({
    ref: '',
    utm_source: '',
    utm_medium: '',
    utm_campaign: '',
  });
  expect(readSignupSource(null)).toEqual({ ref: '', utm_source: '', utm_medium: '', utm_campaign: '' });
  const source = { ref: 'github.com', utm_source: 'gh', utm_medium: '', utm_campaign: 'readme' };
  const carried = withSignupSource('/docs?tab=cli', source);
  expect(carried.length).toBeLessThanOrEqual(512);
  expect(takeSignupSource(carried)).toEqual({ path: '/docs?tab=cli', source });
  expect(takeSignupSource('/pricing')).toEqual({ path: '/pricing', source: null });
  // A return path with no room left keeps the path and drops the source.
  const long = `/${'p'.repeat(500)}`;
  expect(withSignupSource(long, source)).toBe(long);
  // An empty source adds nothing.
  expect(withSignupSource('/', { ref: '', utm_source: '', utm_medium: '', utm_campaign: '' })).toBe('/');
});
