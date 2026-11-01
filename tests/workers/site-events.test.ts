// Cookieless site analytics on the front Worker: one Analytics Engine point per signed-out HTML
// request and per sign-up, never an IP address, cookie or visitor id, and the Cloudflare Web
// Analytics beacon on public pages only when its token is configured. A request is classed from
// its headers; a path that is not a page keeps its first segment only, so scanners stay visible
// and nothing inside a repository is ever recorded. Simulated bindings only.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { frontFetch } from '../../cloudflare/worker/front-routes';
import {
  OWN_TRAFFIC_HEADER,
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
const route = (path: string, sitemap = true) => ({ path, name: path, title: path, description: path, kind: 'page', sitemap });
const manifest = {
  routes: ['/', '/pricing', '/blog', '/docs/guides/sessions', '/company/about'].map((path) => route(path)).concat(route('/signup', false)),
  aliases: { '/company': '/company/about' },
};
/** The platform's anonymous answer for a repository: only alice/compiler is public. */
const publicRepos = () =>
  vi.fn(async (req: Request) =>
    new URL(req.url).pathname.toLowerCase() === '/api/v1/resolve/alice/compiler'
      ? Response.json({ handle: 'alice', name: 'compiler', path: '/alice/compiler' })
      : Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }),
  );
function site(extra: Partial<Env> = {}) {
  const points: AnalyticsEngineDataPoint[] = [];
  const using = {
    ...bindings,
    PLATFORM: undefined,
    SITE_EVENTS: { writeDataPoint: vi.fn((p: AnalyticsEngineDataPoint) => points.push(p)) },
    ASSETS: {
      fetch: async (req: Request) => {
        const { pathname } = new URL(req.url);
        if (pathname === '/_site/routes.json') return Response.json(manifest);
        if (pathname.endsWith('.svg'))
          return new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } });
        return pathname.startsWith('/assets/')
          ? new Response('export {}', { headers: { 'content-type': 'text/javascript' } })
          : new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
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
  'sec-fetch-mode': 'navigate',
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
      'unconfirmed',
    ],
    doubles: [0, 1],
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
  expect(points).toEqual([]);
  const unbound = await frontFetch(get('/pricing'), { ...using, SITE_EVENTS: undefined });
  expect(unbound.status).toBe(200);
});

it('counts a public repository by its own address, drops its own host as a referrer and classes each request', async () => {
  const fetch = publicRepos();
  const { using, points } = site({ PLATFORM: { fetch } as unknown as Fetcher });
  await frontFetch(
    get('/Alice/compiler', { ...visitor, referer: 'https://yonedarepo.test/explore' }),
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
      'sec-fetch-mode': 'navigate',
    }),
    using,
  );
  await frontFetch(get('/pricing', { 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.2)' }), using);
  // A browser's user agent with none of a browser's navigation headers.
  await frontFetch(get('/pricing', { 'user-agent': visitor['user-agent'] }), using);
  expect(points.map((p) => [...(p.blobs ?? []).slice(1, 5), p.blobs?.[9]])).toEqual([
    ['/alice/compiler', '', 'DE', 'desktop', 'unconfirmed'],
    ['/docs/guides/sessions', '', 'DE', 'bot', 'crawler'],
    ['/blog', '', 'DE', 'mobile', 'unconfirmed'],
    ['/pricing', '', 'DE', 'bot', 'agent'],
    ['/pricing', '', 'DE', 'bot', 'bot'],
  ]);
  expect(points.map((p) => p.doubles)).toEqual([[0, 1], [1, 1], [0, 1], [1, 1], [1, 1]]);
});

it('counts site pages at their one address: an alias, a trailing slash, sign-up and Explore', async () => {
  const { using, points } = site();
  for (const path of ['/', '/company', '/pricing/', '/signup', '/explore', '/source/explore'])
    await frontFetch(get(path), using);
  expect(points.map((p) => p.blobs?.[1])).toEqual([
    '/',
    '/company/about',
    '/pricing',
    '/signup',
    '/source/explore',
    '/source/explore',
  ]);
});

it('keeps a scanner path visible at its first segment, and still serves the app', async () => {
  const { using, points } = site({ PLATFORM: { fetch: publicRepos() } as unknown as Fetcher });
  const curl = { 'user-agent': 'curl/8.7.1' };
  const paths: [string, string][] = [
    ['/wp', '/wp'],
    ['/wp-login.php', '/wp-login.php'],
    ['/wp/wp-login.php', '/wp'],
    ['/wp-includes/js/jquery/jquery.js', '/wp-includes'],
    ['/.git/config', '/.git'],
    ['/docs/nope', '/docs'],
    ['/admin', '/admin'],
    ['/settings/tokens', '/settings'],
    ['/ada@example.com/keys', '/(other)'],
    [`/${'x'.repeat(200)}`, '/(other)'],
  ];
  for (const [path] of paths) expect((await frontFetch(get(path, curl), using)).status, path).toBe(200);
  expect(points.map((p) => p.blobs?.[1])).toEqual(paths.map(([, kept]) => kept));
  expect(new Set(points.map((p) => p.blobs?.[9]))).toEqual(new Set(['bot']));
  await frontFetch(get('/wp'), using);
  expect(points.at(-1)?.blobs?.[9]).toBe('unconfirmed');
});

it('never names a private repository or a page inside one, and calls nothing to decide', async () => {
  const fetch = publicRepos();
  const { using, points } = site({ PLATFORM: { fetch } as unknown as Fetcher });
  await frontFetch(get('/alice/secret-plans'), using);
  fetch.mockClear();
  await frontFetch(get('/alice'), using);
  await frontFetch(get('/alice/compiler/tree/main/src/secret-plan.md'), using);
  expect(fetch.mock.calls.filter(([req]) => new URL(req.url).pathname.startsWith('/api/'))).toEqual([]);
  expect(points.map((p) => p.blobs?.[1])).toEqual(['/alice', '/alice', '/alice']);
  expect(JSON.stringify(points)).not.toContain('secret');
  // A public repository's page asks once, for its head; the point reuses that answer.
  await frontFetch(get('/alice/compiler'), using);
  expect(fetch.mock.calls.filter(([req]) => new URL(req.url).pathname.startsWith('/api/'))).toHaveLength(1);
  expect(points.at(-1)?.blobs?.[1]).toBe('/alice/compiler');
  // An outage names nothing either.
  const down = vi.fn(async () => new Response('unavailable', { status: 503 }));
  const outage = site({ PLATFORM: { fetch: down } as unknown as Fetcher });
  await frontFetch(get('/alice/compiler'), outage.using);
  expect(outage.points.map((p) => p.blobs?.[1])).toEqual(['/alice']);
});

it('keeps the beacon off app pages while their signed-out requests are recorded', async () => {
  const { using, points } = site({ WEB_ANALYTICS_TOKEN: token });
  expect(await (await frontFetch(get('/settings'), using)).text()).not.toContain('cloudflareinsights');
  expect(points.map((p) => p.blobs?.[1])).toEqual(['/settings']);
});

it("leaves the live tests' browser out of both counts and changes nothing else about the page", async () => {
  const { using, points } = site({ WEB_ANALYTICS_TOKEN: token });
  const marked = { ...visitor, [OWN_TRAFFIC_HEADER]: '1' };
  const response = await frontFetch(get('/pricing', marked), using);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain('cloudflareinsights');
  expect(points).toEqual([]);
  // Only the exact mark counts as ours; anything else is an ordinary visitor.
  const other = await frontFetch(get('/pricing', { ...visitor, [OWN_TRAFFIC_HEADER]: 'yes' }), using);
  expect(await other.text()).toContain('cloudflareinsights');
  expect(points).toHaveLength(1);
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
  expect(await response.text()).toContain('<title>/pricing</title>');
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
      blobs: ['signup', '', 'news.ycombinator.com', 'FR', 'desktop', 'hn', '', 'x'.repeat(64), 'email', ''],
      doubles: [0, 1],
    },
  ]);
  expect(JSON.stringify(points)).not.toContain('carol');
});

it('records no sign-up from our own tools', async () => {
  const { using, points } = site();
  const response = await frontFetch(
    new Request('https://yonedarepo.test/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yoneda-own-traffic': '1', ...visitor },
      body: JSON.stringify({ email: 'tester@example.com', password: 'a long test password' }),
    } as RequestInit),
    using,
  );
  expect(response.status).toBe(200);
  expect(points).toEqual([]);
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
