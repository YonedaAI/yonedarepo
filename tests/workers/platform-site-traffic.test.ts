// Site traffic reports (platform Worker): the Analytics Engine SQL the admin Traffic page runs,
// how humans, agents and bots fold out of it, and how answers and failures come back, with the Web
// Analytics cross-check beside it. The SQL and GraphQL APIs are simulated; no token is real.
import { expect, it, vi } from 'vitest';
import { siteTraffic, trafficClass } from '../../cloudflare/worker/platform-site-traffic';
import { trafficQueries } from '../../cloudflare/worker/platform-traffic-queries';
import { webAnalytics } from '../../cloudflare/worker/platform-web-analytics';
import type { Env } from '../../cloudflare/worker/types';

const configured = {
  TRAFFIC_EVENTS: 'on',
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
const D = 'yonedarepo_dev_site_events';

it('counts each class its own way in the top lists', () => {
  expect(trafficQueries(D, 7, 'humans').top_pages).toBe(
    `SELECT blob2 AS key, SUM(_sample_interval) AS count FROM ${D} WHERE blob1 = 'ping' AND timestamp > NOW() - INTERVAL '7' DAY GROUP BY key ORDER BY count DESC LIMIT 25 FORMAT JSON`,
  );
  expect(trafficQueries(D, 7, 'agents').top_pages).toBe(
    `SELECT blob2 AS key, SUM(_sample_interval) AS count FROM ${D} WHERE blob1 = 'pageview' AND blob10 = 'agent' AND timestamp > NOW() - INTERVAL '7' DAY GROUP BY key ORDER BY count DESC LIMIT 25 FORMAT JSON`,
  );
  // Bots are the other classed page requests less the pings that confirmed one: a signed-in
  // page request was never recorded, so its ping confirms nothing.
  expect(trafficQueries(D, 30, 'bots').top_pages).toBe(
    `SELECT blob2 AS key, SUM(_sample_interval * if(blob1 = 'ping', -1, 1)) AS count FROM ${D} WHERE ((blob1 = 'ping' AND blob10 = 'human') OR (blob1 = 'pageview' AND double2 = 1 AND blob10 != 'agent')) AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY key HAVING count > 0 ORDER BY count DESC LIMIT 25 FORMAT JSON`,
  );
});

it('builds windowed queries over the one dataset', () => {
  const q = trafficQueries(D, 7, 'humans');
  expect(q.top_referrers).toContain('blob3 AS key');
  expect(q.top_referrers).toContain("AND blob3 != ''");
  expect(q.countries).toContain('blob4 AS key');
  expect(q.campaigns).toContain('GROUP BY utm_source, utm_medium, utm_campaign');
  expect(q.campaigns).toContain("AND (blob6 != '' OR blob7 != '' OR blob8 != '')");
  // Campaign tags ride on page requests: a bot-flagged one stays out.
  expect(q.campaigns).toContain("blob1 = 'pageview' AND double1 = 0");
  expect(q.signups_7).toContain("WHERE blob1 = 'signup' AND timestamp > NOW() - INTERVAL '7' DAY");
  expect(q.signups_30).toContain("INTERVAL '30' DAY");
  expect(q.classed_since).toBe(
    `SELECT MIN(timestamp) AS since FROM ${D} WHERE blob1 = 'pageview' AND double2 = 1 FORMAT JSON`,
  );
  // A platform point stands for `double3` requests.
  for (const sql of [q.by_day, q.totals]) expect(sql).toContain("if(blob1 = 'client', double3, 1.0)");
  // Points from before classes, and platform points from before our tools were marked, are out.
  for (const sql of [q.by_day, q.totals])
    expect(sql).toContain("double2 = 1 AND (blob1 != 'client' OR double5 = 1)");
  expect(q.clients).toContain("blob1 = 'client' AND double5 = 1");
  expect(q.clients).toContain('SUM(_sample_interval * double3) AS count');
  expect(q.clients).toContain('SUM(_sample_interval * double3 * double4) AS with_token');
  expect(q.by_day).toContain("INTERVAL '30' DAY");
  for (const sql of Object.values(q)) {
    expect(sql).toContain(`FROM ${D} `);
    expect(sql).toMatch(/FORMAT JSON$/);
  }
  for (const sql of [q.totals, q.clients, q.top_pages, q.top_referrers, q.countries, q.campaigns])
    expect(sql).toContain("INTERVAL '7' DAY");
  expect(() => trafficQueries('x; DROP TABLE y', 7, 'humans')).toThrow();
  expect(() => trafficQueries('yonedarepo-dev-site-events', 30, 'humans')).toThrow();
});

it('takes the filter from the query, Humans unless it names another class', () => {
  expect(['humans', 'agents', 'bots', 'x', null].map(trafficClass)).toEqual([
    'humans',
    'agents',
    'bots',
    'humans',
    'humans',
  ]);
});

/** A report whose every section answers one recognisable row set. */
const answers = (body: string) => {
  if (body.includes('AS day'))
    return [
      { day: '2026-10-29', event: 'ping', class: 'human', count: '12' },
      { day: '2026-10-29', event: 'ping', class: 'signed_in', count: '1' },
      { day: '2026-10-29', event: 'pageview', class: 'unconfirmed', count: 15 },
      { day: '2026-10-29', event: 'client', class: 'agent', count: 8 },
      { day: '2026-10-30', event: 'pageview', class: '', count: '3' },
      { day: '2026-10-30', event: 'pageview', class: 'agent', count: '2' },
    ];
  if (body.includes('MIN(timestamp)')) return [{ since: '2026-11-02 09:30:00' }];
  if (body.includes('blob1 IN'))
    return [
      { event: 'ping', class: 'human', count: '40' },
      { event: 'ping', class: 'signed_in', count: '6' },
      { event: 'pageview', class: 'unconfirmed', count: '55' },
      { event: 'pageview', class: 'bot', count: '30' },
      { event: 'pageview', class: 'crawler', count: '7' },
      { event: 'pageview', class: 'agent', count: '9' },
      { event: 'client', class: 'agent', count: 120 },
    ];
  if (body.includes('AS with_token'))
    return [{ client: 'git', operation: 'clone', count: 100, with_token: '60' }];
  if (body.includes("blob1 = 'signup'"))
    return [{ provider: 'github', referrer: 'news.ycombinator.com', utm_source: 'hn', utm_campaign: '', count: '2' }];
  if (body.includes('utm_medium'))
    return [{ utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch', count: '5' }];
  return [{ key: '/pricing', count: '9' }];
};

it('runs every query with the read token and folds humans, agents and bots', async () => {
  const sent: { url: string; auth: string | null; body: string }[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const body = String(init?.body);
    if (url === GRAPHQL) return loads(40, 9);
    sent.push({ url, auth: new Headers(init?.headers).get('authorization'), body });
    const data = answers(body);
    return Response.json({ meta: [], data, rows: data.length });
  });
  const result = await siteTraffic(configured, 30, 'humans', fetcher as unknown as typeof fetch);
  expect(sent).toHaveLength(10);
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
      class: 'humans',
      classed_since: '2026-11-02',
      counting: true,
      // 55 unconfirmed + 30 bot + 7 crawler, less the 40 signed-out pings that confirmed some.
      headline: { humans: 46, humans_signed_in: 6, agents_site: 9, agents_platform: 120, bots: 52, crawlers: 7 },
      web_analytics: { ok: true, host: 'dev.yonedarepo.com', page_loads: 40, visits: 9 },
      by_day: [
        { day: '2026-10-29', humans: 13, agents: 8, bots: 3 },
        { day: '2026-10-30', humans: 0, agents: 2, bots: 3 },
      ],
      top_pages: [{ key: '/pricing', count: 9 }],
      top_referrers: [{ key: '/pricing', count: 9 }],
      countries: [{ key: '/pricing', count: 9 }],
      clients: [{ client: 'git', operation: 'clone', count: 100, with_token: 60 }],
      campaigns: [{ utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch', count: 5 }],
      signups: {
        last_7: [{ provider: 'github', referrer: 'news.ycombinator.com', utm_source: 'hn', utm_campaign: '', count: 2 }],
        last_30: [{ provider: 'github', referrer: 'news.ycombinator.com', utm_source: 'hn', utm_campaign: '', count: 2 }],
      },
    },
  });
});

it('never reads more pings than page requests as negative bots', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === GRAPHQL) return loads(0, 0);
    const body = String(init?.body);
    return body.includes('blob1 IN') && !body.includes('AS day')
      ? Response.json({ data: [{ event: 'ping', class: 'human', count: 5 }] })
      : sqlRows(body);
  });
  const result = await siteTraffic(configured, 7, 'bots', fetcher as unknown as typeof fetch);
  expect(result.ok && result.traffic.headline.bots).toBe(0);
  expect(result.ok && result.traffic.class).toBe('bots');
});

it('reports a missing configuration or a failed query without leaking the token', async () => {
  const never = vi.fn();
  for (const missing of ['CF_ACCOUNT_ID', 'SITE_EVENTS_DATASET', 'ANALYTICS_READ_TOKEN'] as const)
    expect(
      await siteTraffic({ ...configured, [missing]: undefined }, 7, 'humans', never as unknown as typeof fetch),
    ).toEqual({ ok: false, reason: 'not_configured' });
  expect(never).not.toHaveBeenCalled();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const refused = vi.fn(async () => new Response('{"errors":[{"message":"bad token"}]}', { status: 403 }));
  expect(await siteTraffic(configured, 7, 'humans', refused as unknown as typeof fetch)).toEqual({
    ok: false,
    reason: 'query_failed',
  });
  const malformed = vi.fn(async () => Response.json({ data: 'nope' }));
  expect(await siteTraffic(configured, 7, 'humans', malformed as unknown as typeof fetch)).toEqual({
    ok: false,
    reason: 'query_failed',
  });
  expect(JSON.stringify(errors.mock.calls)).not.toContain('test-read-token');
  errors.mockRestore();
});

it('says nothing is classed yet instead of reading the empty answer as 1970', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    url === GRAPHQL ? loads(0, 0) : sqlRows(String(init?.body)),
  );
  const result = await siteTraffic(configured, 7, 'humans', fetcher as unknown as typeof fetch);
  expect(result.ok && result.traffic.classed_since).toBe(null);
  expect(result.ok && result.traffic.headline.humans).toBe(0);
});

it('says when requests are not being counted here', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    url === GRAPHQL ? loads(0, 0) : sqlRows(String(init?.body)),
  );
  const off = { ...configured, TRAFFIC_EVENTS: 'off' } as unknown as Env;
  const result = await siteTraffic(off, 7, 'humans', fetcher as unknown as typeof fetch);
  expect(result.ok && result.traffic.counting).toBe(false);
});

it('compares Web Analytics only over the time pings have been counted', async () => {
  const asked: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== GRAPHQL) {
      const body = String(init?.body);
      return Response.json({ data: body.includes('MIN(timestamp)') ? [{ since: '2099-01-01 09:30:00' }] : [] });
    }
    asked.push(JSON.parse(String(init?.body)).variables.filter.datetime_geq);
    return loads(1, 1);
  });
  await siteTraffic(configured, 7, 'humans', fetcher as unknown as typeof fetch);
  expect(asked).toEqual(['2099-01-01T09:30:00.000Z']);
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
    const result = await siteTraffic(configured, 7, 'humans', fetcher as unknown as typeof fetch);
    expect(result.ok && result.traffic.web_analytics).toEqual({ ok: false, reason: 'query_failed' });
  }
  const unset = vi.fn(async (_url: string, init?: RequestInit) => sqlRows(String(init?.body)));
  const noOrigin = await siteTraffic(
    { ...configured, WEB_ORIGIN: undefined },
    7,
    'humans',
    unset as unknown as typeof fetch,
  );
  expect(noOrigin.ok && noOrigin.traffic.web_analytics).toEqual({ ok: false, reason: 'not_configured' });
  expect(unset.mock.calls.map(([url]) => url)).not.toContain(GRAPHQL);
  expect(JSON.stringify(errors.mock.calls)).not.toContain('test-read-token');
  errors.mockRestore();
});
