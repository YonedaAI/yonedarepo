// Site traffic reports (platform Worker): the Analytics Engine SQL the admin Traffic page runs,
// and how its answers and failures come back, with the Web Analytics cross-check beside it. The
// SQL and GraphQL APIs are simulated; no token is real.
import { expect, it, vi } from 'vitest';
import { siteTraffic, trafficQueries } from '../../cloudflare/worker/platform-site-traffic';
import { webAnalytics } from '../../cloudflare/worker/platform-web-analytics';
import type { Env } from '../../cloudflare/worker/types';

const configured = {
  CF_ACCOUNT_ID: 'f011d0ee02b23cad26b4b38151b204ad',
  SITE_EVENTS_DATASET: 'yonedarepo_dev_site_events',
  ANALYTICS_READ_TOKEN: 'test-read-token',
  WEB_ORIGIN: 'https://dev.yonedarepo.com/',
} as unknown as Env;

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const loads = (count: number, visits: number) =>
  Response.json({
    data: { viewer: { accounts: [{ total: [{ count, sum: { visits } }] }] } },
    errors: null,
  });
/** The SQL API answering rows for one report, for tests about what surrounds it. */
const sqlRows = (body: string) =>
  Response.json({
    data: body.includes('MIN(timestamp)') ? [{ since: '1970-01-01 00:00:00' }] : [],
  });

it('builds bot-free, windowed queries over the one dataset', () => {
  const q = trafficQueries('yonedarepo_dev_site_events', 7);
  expect(q.views_by_day).toBe(
    "SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS day, SUM(_sample_interval) AS views FROM yonedarepo_dev_site_events WHERE blob1 = 'pageview' AND double1 = 0 AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY day ORDER BY day ASC FORMAT JSON",
  );
  expect(q.top_pages).toBe(
    "SELECT blob2 AS key, SUM(_sample_interval) AS count FROM yonedarepo_dev_site_events WHERE blob1 = 'pageview' AND double1 = 0 AND timestamp > NOW() - INTERVAL '7' DAY GROUP BY key ORDER BY count DESC LIMIT 25 FORMAT JSON",
  );
  expect(q.top_referrers).toContain("blob3 AS key");
  expect(q.top_referrers).toContain("AND blob3 != ''");
  expect(q.countries).toContain('blob4 AS key');
  expect(q.campaigns).toContain("GROUP BY utm_source, utm_medium, utm_campaign");
  expect(q.campaigns).toContain("AND (blob6 != '' OR blob7 != '' OR blob8 != '')");
  expect(q.signups_7).toContain("WHERE blob1 = 'signup' AND timestamp > NOW() - INTERVAL '7' DAY");
  expect(q.signups_30).toContain("INTERVAL '30' DAY");
  expect(q.views_total).toBe(
    "SELECT SUM(_sample_interval) AS views FROM yonedarepo_dev_site_events WHERE blob1 = 'pageview' AND double1 = 0 AND timestamp > NOW() - INTERVAL '7' DAY FORMAT JSON",
  );
  expect(q.filtered_since).toBe(
    "SELECT MIN(timestamp) AS since FROM yonedarepo_dev_site_events WHERE blob1 = 'pageview' AND double2 = 1 FORMAT JSON",
  );
  // Bot-flagged points stay in the dataset and out of every page-view section.
  for (const sql of [q.views_by_day, q.views_total, q.top_pages, q.top_referrers, q.countries, q.campaigns])
    expect(sql).toContain('double1 = 0');
  for (const sql of Object.values(q)) {
    expect(sql).toContain('FROM yonedarepo_dev_site_events ');
    expect(sql).toMatch(/FORMAT JSON$/);
  }
  for (const sql of [q.views_total, q.top_pages, q.top_referrers, q.countries, q.campaigns])
    expect(sql).toContain("INTERVAL '7' DAY");
  expect(() => trafficQueries('x; DROP TABLE y', 7)).toThrow();
  expect(() => trafficQueries('yonedarepo-dev-site-events', 30)).toThrow();
});

it('runs every query against the SQL API with the read token and shapes the answers', async () => {
  const sent: { url: string; auth: string | null; body: string }[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const body = String(init?.body);
    if (url === GRAPHQL) return loads(40, 9);
    sent.push({ url, auth: new Headers(init?.headers).get('authorization'), body });
    const data = body.includes('AS day')
      ? [{ day: '2026-10-29', views: '12' }, { day: '2026-10-30', views: 3 }]
      : body.includes('MIN(timestamp)')
        ? [{ since: '2026-11-02 09:30:00' }]
      : body.includes('SUM(_sample_interval) AS views')
        ? [{ views: '15' }]
      : body.includes("blob1 = 'signup'")
        ? [{ provider: 'github', referrer: 'news.ycombinator.com', utm_source: 'hn', utm_campaign: '', count: '2' }]
        : body.includes('utm_medium')
          ? [{ utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch', count: '5' }]
          : [{ key: '/pricing', count: '9' }];
    return Response.json({ meta: [], data, rows: data.length });
  });
  const result = await siteTraffic(configured, 30, fetcher as unknown as typeof fetch);
  expect(sent).toHaveLength(9);
  for (const call of sent) {
    expect(call.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/f011d0ee02b23cad26b4b38151b204ad/analytics_engine/sql',
    );
    expect(call.auth).toBe('Bearer test-read-token');
  }
  expect(result).toEqual({
    ok: true,
    traffic: {
      days: 30,
      filtered_since: '2026-11-02',
      views_total: 15,
      web_analytics: { ok: true, host: 'dev.yonedarepo.com', page_loads: 40, visits: 9 },
      views_by_day: [
        { day: '2026-10-29', views: 12 },
        { day: '2026-10-30', views: 3 },
      ],
      top_pages: [{ key: '/pricing', count: 9 }],
      top_referrers: [{ key: '/pricing', count: 9 }],
      countries: [{ key: '/pricing', count: 9 }],
      campaigns: [{ utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch', count: 5 }],
      signups: {
        last_7: [{ provider: 'github', referrer: 'news.ycombinator.com', utm_source: 'hn', utm_campaign: '', count: 2 }],
        last_30: [{ provider: 'github', referrer: 'news.ycombinator.com', utm_source: 'hn', utm_campaign: '', count: 2 }],
      },
    },
  });
});

it('reports a missing configuration or a failed query without leaking the token', async () => {
  const never = vi.fn();
  for (const missing of ['CF_ACCOUNT_ID', 'SITE_EVENTS_DATASET', 'ANALYTICS_READ_TOKEN'] as const)
    expect(await siteTraffic({ ...configured, [missing]: undefined }, 7, never as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: 'not_configured',
    });
  expect(never).not.toHaveBeenCalled();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const refused = vi.fn(async () => new Response('{"errors":[{"message":"bad token"}]}', { status: 403 }));
  expect(await siteTraffic(configured, 7, refused as unknown as typeof fetch)).toEqual({
    ok: false,
    reason: 'query_failed',
  });
  const malformed = vi.fn(async () => Response.json({ data: 'nope' }));
  expect(await siteTraffic(configured, 7, malformed as unknown as typeof fetch)).toEqual({
    ok: false,
    reason: 'query_failed',
  });
  expect(JSON.stringify(errors.mock.calls)).not.toContain('test-read-token');
  errors.mockRestore();
});

it('says no filtered row exists yet instead of reading the empty answer as 1970', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    url === GRAPHQL ? loads(0, 0) : sqlRows(String(init?.body)),
  );
  const result = await siteTraffic(configured, 7, fetcher as unknown as typeof fetch);
  expect(result.ok && result.traffic.filtered_since).toBe(null);
  expect(result.ok && result.traffic.views_total).toBe(0);
});

it('asks Web Analytics for this site over the same window, leaving bots out', async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => loads(641, 95));
  const now = Date.UTC(2026, 9, 31, 20);
  expect(
    await webAnalytics(configured, 7, fetcher as unknown as typeof fetch, now),
  ).toEqual({ ok: true, host: 'dev.yonedarepo.com', page_loads: 641, visits: 95 });
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe(GRAPHQL);
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-read-token');
  const asked = JSON.parse(String(init?.body));
  expect(asked.query).toContain('rumPageloadEventsAdaptiveGroups');
  expect(asked.variables).toEqual({
    account: 'f011d0ee02b23cad26b4b38151b204ad',
    filter: {
      requestHost: 'dev.yonedarepo.com',
      bot: 0,
      datetime_geq: '2026-10-24T20:00:00.000Z',
      datetime_leq: '2026-10-31T20:00:00.000Z',
    },
  });
});

it('reads an empty Web Analytics window as zero', async () => {
  const empty = vi.fn(async () =>
    Response.json({ data: { viewer: { accounts: [{ total: [] }] } }, errors: null }),
  );
  expect(await webAnalytics(configured, 30, empty as unknown as typeof fetch)).toEqual({
    ok: true,
    host: 'dev.yonedarepo.com',
    page_loads: 0,
    visits: 0,
  });
});

it('keeps the report when Web Analytics cannot be read, and says why', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const failing = [
    async () => new Response('{"errors":[{"message":"bad token"}]}', { status: 403 }),
    async () => Response.json({ data: null, errors: [{ message: 'not authorized for that account' }] }),
    async () => Response.json({ data: { viewer: { accounts: [] } }, errors: null }),
    async () => {
      throw new Error('network');
    },
  ];
  for (const answer of failing) {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
      url === GRAPHQL ? answer() : sqlRows(String(init?.body)),
    );
    const result = await siteTraffic(configured, 7, fetcher as unknown as typeof fetch);
    expect(result.ok && result.traffic.web_analytics).toEqual({ ok: false, reason: 'query_failed' });
  }
  const unset = vi.fn(async (_url: string, init?: RequestInit) => sqlRows(String(init?.body)));
  const noOrigin = await siteTraffic(
    { ...configured, WEB_ORIGIN: undefined },
    7,
    unset as unknown as typeof fetch,
  );
  expect(noOrigin.ok && noOrigin.traffic.web_analytics).toEqual({ ok: false, reason: 'not_configured' });
  expect(unset.mock.calls.map(([url]) => url)).not.toContain(GRAPHQL);
  expect(JSON.stringify(errors.mock.calls)).not.toContain('test-read-token');
  errors.mockRestore();
});
