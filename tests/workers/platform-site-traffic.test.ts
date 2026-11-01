// Site traffic reports (platform Worker): the Analytics Engine SQL the admin Traffic page runs,
// how humans, agents and bots fold out of it, and how answers and failures come back, with the Web
// Analytics cross-check beside it. The SQL and GraphQL APIs are simulated; no token is real.
import { expect, it, vi } from 'vitest';
import { siteTraffic, trafficClass, trafficRange } from '../../cloudflare/worker/platform-site-traffic';
import { trafficQueries, trafficSpan } from '../../cloudflare/worker/platform-traffic-queries';
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
const NOW = Date.UTC(2026, 11, 20, 15, 30);
const report = { ...configured, TRAFFIC_REPORT: 'on' } as unknown as Env;
const spanOf = (range: '24h' | '7d' | '30d' | '90d') => trafficSpan(range, NOW);
const sevenDays = 'timestamp >= toDateTime(1797206400)';
const thirtyDays = 'timestamp >= toDateTime(1795219200)';

it('counts each class its own way in the top lists', () => {
  expect(trafficQueries(D, spanOf('7d'), 'humans').top_pages).toBe(
    `SELECT blob2 AS key, SUM(_sample_interval) AS count, MAX(_sample_interval) AS sampling FROM ${D} WHERE blob1 = 'ping' AND ${sevenDays} GROUP BY key ORDER BY count DESC LIMIT 25 FORMAT JSON`,
  );
  expect(trafficQueries(D, spanOf('7d'), 'agents').top_pages).toBe(
    `SELECT blob2 AS key, SUM(_sample_interval) AS count, MAX(_sample_interval) AS sampling FROM ${D} WHERE blob1 = 'pageview' AND blob10 = 'agent' AND ${sevenDays} GROUP BY key ORDER BY count DESC LIMIT 25 FORMAT JSON`,
  );
  // Bots are the other classed page requests less the pings that confirmed one: a signed-in
  // page request was never recorded, so its ping confirms nothing.
  expect(trafficQueries(D, spanOf('30d'), 'bots').top_pages).toBe(
    `SELECT blob2 AS key, SUM(_sample_interval * if(blob1 = 'ping', -1, 1)) AS count, MAX(_sample_interval) AS sampling FROM ${D} WHERE ((blob1 = 'ping' AND blob10 = 'human') OR (blob1 = 'pageview' AND double2 = 1 AND blob10 != 'agent')) AND ${thirtyDays} GROUP BY key HAVING count > 0 ORDER BY count DESC LIMIT 25 FORMAT JSON`,
  );
});

it('builds windowed queries over the one dataset', () => {
  const q = trafficQueries(D, spanOf('7d'), 'humans');
  expect(q.top_referrers).toContain('blob3 AS key');
  expect(q.top_referrers).toContain("AND blob3 != ''");
  expect(q.countries).toContain('blob4 AS key');
  expect(q.campaigns).toContain('GROUP BY utm_source, utm_medium, utm_campaign');
  expect(q.campaigns).toContain("AND (blob6 != '' OR blob7 != '' OR blob8 != '')");
  // Campaign tags ride on page requests: a bot-flagged one stays out.
  expect(q.campaigns).toContain("blob1 = 'pageview' AND double1 = 0");
  expect(q.signups).toContain(`WHERE blob1 = 'signup' AND ${sevenDays}`);
  expect(q.classed_since).toBe(
    `SELECT MIN(timestamp) AS since FROM ${D} WHERE blob1 = 'pageview' AND double2 = 1 FORMAT JSON`,
  );
  // A platform point stands for `double3` requests.
  for (const sql of [q.series, q.totals]) expect(sql).toContain("if(blob1 = 'client', double3, 1.0)");
  // Points from before classes, and platform points from before our tools were marked, are out.
  for (const sql of [q.series, q.totals])
    expect(sql).toContain("double2 = 1 AND (blob1 != 'client' OR double5 = 1)");
  expect(q.clients).toContain("blob1 = 'client' AND double5 = 1");
  expect(q.clients).toContain('SUM(_sample_interval * double3) AS count');
  expect(q.clients).toContain('SUM(_sample_interval * double3 * double4) AS with_token');
  for (const sql of Object.values(q)) {
    expect(sql).toContain(`FROM ${D} `);
    expect(sql).toMatch(/FORMAT JSON$/);
  }
  for (const sql of [q.totals, q.clients, q.top_pages, q.top_referrers, q.countries, q.campaigns])
    expect(sql).toContain(sevenDays);
  expect(() => trafficQueries('x; DROP TABLE y', spanOf('7d'), 'humans')).toThrow();
  expect(() => trafficQueries('yonedarepo-dev-site-events', spanOf('30d'), 'humans')).toThrow();
});

it('draws the chart over the range it reports, not always 30 days', () => {
  expect(trafficQueries(D, spanOf('7d'), 'humans').series).toContain(sevenDays);
  expect(trafficQueries(D, spanOf('30d'), 'humans').series).toContain(thirtyDays);
  expect(trafficQueries(D, spanOf('24h'), 'humans').series).toContain("INTERVAL '1' HOUR");
  // Weeks are days, folded by the Worker: SQL has no week it can count back from today.
  expect(trafficQueries(D, spanOf('90d'), 'humans').series).toContain("INTERVAL '1' DAY");
});

it('cuts each range into hours, days or weeks, ending with the one in progress', () => {
  const shape = (range: Parameters<typeof spanOf>[0]) => {
    const s = spanOf(range);
    return [s.bucket, s.buckets, new Date(s.start).toISOString(), s.close - s.start];
  };
  expect(shape('24h')).toEqual(['hour', 24, '2026-12-19T16:00:00.000Z', 24 * 3_600_000]);
  expect(shape('7d')).toEqual(['day', 7, '2026-12-14T00:00:00.000Z', 7 * 86_400_000]);
  expect(shape('30d')).toEqual(['day', 30, '2026-11-21T00:00:00.000Z', 30 * 86_400_000]);
  expect(shape('90d')).toEqual(['week', 13, '2026-09-22T00:00:00.000Z', 90 * 86_400_000]);
});

it('compares with the period just before, as long as this one, unless that is past what is kept', () => {
  const q = trafficQueries(D, spanOf('7d'), 'humans');
  const start = spanOf('7d').start;
  const before = spanOf('7d').previous_start as number;
  expect(start - before).toBe(NOW - start);
  expect(q.previous).toContain(`timestamp >= toDateTime(${before / 1000})`);
  expect(q.previous).toContain(`timestamp < toDateTime(${start / 1000})`);
  // The 90 days before these 90 are past the three months Analytics Engine keeps.
  expect(spanOf('90d').previous_start).toBe(null);
  expect(trafficQueries(D, spanOf('90d'), 'humans').previous).toBeUndefined();
  expect(trafficQueries(D, spanOf('7d'), 'humans', { compare: false }).previous).toBeUndefined();
});

it('offers every range only with the switch on, and 30 days for anything else', () => {
  expect(['24h', '7d', '30d', '90d', 'x', null].map((r) => trafficRange(report, r))).toEqual([
    '24h',
    '7d',
    '30d',
    '90d',
    '30d',
    '30d',
  ]);
  expect(['24h', '7d', '90d'].map((r) => trafficRange(configured, r))).toEqual(['30d', '7d', '30d']);
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
  if (body.includes('AS bucket'))
    return [
      { bucket: '2026-12-14T00', event: 'ping', class: 'human', count: '12' },
      { bucket: '2026-12-15T00', event: 'ping', class: 'human', count: '12', sampling: 1 },
      { bucket: '2026-12-15T00', event: 'ping', class: 'signed_in', count: '1', sampling: 1 },
      { bucket: '2026-12-15T00', event: 'pageview', class: 'unconfirmed', count: 15, sampling: 1 },
      { bucket: '2026-12-15T00', event: 'client', class: 'agent', count: 8, sampling: 10 },
      { bucket: '2026-12-20T00', event: 'pageview', class: '', count: '3', sampling: 1 },
      { bucket: '2026-12-20T00', event: 'pageview', class: 'agent', count: '2', sampling: 1 },
    ];
  if (body.includes('MIN(timestamp)')) return [{ since: '2026-11-02 09:30:00' }];
  if (body.includes('blob1 IN') && body.includes('timestamp < toDateTime'))
    return [{ event: 'ping', class: 'human', count: '20', sampling: 1 }];
  if (body.includes('blob1 IN'))
    return [
      { event: 'ping', class: 'human', count: '40', sampling: 1 },
      { event: 'ping', class: 'signed_in', count: '6', sampling: 1 },
      { event: 'pageview', class: 'unconfirmed', count: '55', sampling: 1 },
      { event: 'pageview', class: 'bot', count: '30', sampling: 1 },
      { event: 'pageview', class: 'crawler', count: '7', sampling: 1 },
      { event: 'pageview', class: 'agent', count: '9', sampling: 1 },
      { event: 'client', class: 'agent', count: 120, sampling: 10 },
    ];
  if (body.includes('AS with_token'))
    return [{ client: 'git', operation: 'clone', count: 100, with_token: '60', sampling: 1 }];
  if (body.includes("blob1 = 'signup'"))
    return [{ provider: 'github', referrer: 'news.ycombinator.com', utm_source: 'hn', utm_campaign: '', count: '2', sampling: 1 }];
  if (body.includes('utm_medium'))
    return [{ utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch', count: '5', sampling: 1 }];
  return [{ key: '/pricing', count: '9', sampling: 2 }];
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
  const result = await siteTraffic(report, '7d', 'humans', fetcher as unknown as typeof fetch, NOW);
  expect(sent).toHaveLength(10);
  for (const call of sent) {
    expect(call.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/f011d0ee02b23cad26b4b38151b204ad/analytics_engine/sql',
    );
    expect(call.auth).toBe('Bearer test-read-token');
  }
  if (!result.ok) throw new Error('no report');
  const { series, ...rest } = result.traffic;
  expect(rest).toEqual({
    range: '7d',
    ranges: ['24h', '7d', '30d', '90d'],
    days: 7,
    class: 'humans',
    classed_since: '2026-11-02',
    counting: true,
      repo_analytics: false,
    // 55 unconfirmed + 30 bot + 7 crawler, less the 40 signed-out pings that confirmed some.
    headline: {
      humans: 46,
      humans_signed_in: 6,
      agents_site: 9,
      agents_platform: 120,
      bots: 52,
      crawlers: 7,
      // One platform point stood for ten requests.
      estimated: ['agents'],
    },
    previous: {
      humans: 20,
      humans_signed_in: 0,
      agents_site: 0,
      agents_platform: 0,
      bots: 0,
      crawlers: 0,
      estimated: [],
    },
    web_analytics: { ok: true, host: 'dev.yonedarepo.com', page_loads: 40, visits: 9 },
    bucket: 'day',
    top_pages: [{ key: '/pricing', count: 9, estimated: true }],
    top_referrers: [{ key: '/pricing', count: 9, estimated: true }],
    countries: [{ key: '/pricing', count: 9, estimated: true }],
    clients: [{ client: 'git', operation: 'clone', count: 100, with_token: 60, estimated: false }],
    campaigns: [
      { utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch', count: 5, estimated: false },
    ],
    signups: [
      {
        provider: 'github',
        referrer: 'news.ycombinator.com',
        utm_source: 'hn',
        utm_campaign: '',
        count: 2,
        estimated: false,
      },
    ],
  });
  // One bar for each of the seven days, gaps included.
  expect(series.map((b) => b.start.slice(0, 10))).toEqual([
    '2026-12-14',
    '2026-12-15',
    '2026-12-16',
    '2026-12-17',
    '2026-12-18',
    '2026-12-19',
    '2026-12-20',
  ]);
  expect(series[1]).toEqual({
    start: '2026-12-15T00:00:00.000Z',
    end: '2026-12-16T00:00:00.000Z',
    humans: 13,
    agents: 8,
    bots: 3,
    estimated: ['agents'],
  });
  expect(series[0]).toMatchObject({ humans: 12, agents: 0, bots: 0 });
  expect(series[2]).toMatchObject({ humans: 0, agents: 0, bots: 0 });
  expect(series[6]).toMatchObject({ humans: 0, agents: 2, bots: 3, estimated: [] });
});

it('folds 90 days into weeks counted back from today, the first one short', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === GRAPHQL) return loads(0, 0);
    const body = String(init?.body);
    if (!body.includes('AS bucket')) return sqlRows(body);
    return Response.json({
      data: [
        { bucket: '2026-09-23T00', event: 'ping', class: 'human', count: 1, sampling: 1 },
        { bucket: '2026-12-13T00', event: 'ping', class: 'human', count: 2, sampling: 1 },
        { bucket: '2026-12-14T00', event: 'ping', class: 'human', count: 4, sampling: 1 },
        { bucket: '2026-12-20T00', event: 'ping', class: 'human', count: 8, sampling: 1 },
      ],
    });
  });
  const result = await siteTraffic(report, '90d', 'humans', fetcher as unknown as typeof fetch, NOW);
  if (!result.ok) throw new Error('no report');
  const { series, bucket, previous } = result.traffic;
  expect([bucket, series.length, previous]).toEqual(['week', 13, null]);
  expect(series[0]).toMatchObject({
    start: '2026-09-22T00:00:00.000Z',
    end: '2026-09-28T00:00:00.000Z',
    humans: 1,
  });
  expect(series[11]).toMatchObject({ end: '2026-12-14T00:00:00.000Z', humans: 2 });
  expect(series[12]).toMatchObject({
    start: '2026-12-14T00:00:00.000Z',
    end: '2026-12-21T00:00:00.000Z',
    humans: 12,
  });
  expect(series.every((b) => b.start < b.end)).toBe(true);
});

it('shows no comparison over a period that was only partly counted', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === GRAPHQL) return loads(0, 0);
    const body = String(init?.body);
    if (body.includes('MIN(timestamp)')) return Response.json({ data: [{ since: '2026-12-10 09:00:00' }] });
    return Response.json({ data: answers(body) });
  });
  const run = (range: '7d' | '30d') =>
    siteTraffic(report, range, 'humans', fetcher as unknown as typeof fetch, NOW);
  // Counting began inside the previous 7 days, and long after the previous 30 began.
  for (const range of ['7d', '30d'] as const) {
    const result = await run(range);
    expect(result.ok && result.traffic.previous).toBe(null);
  }
});

it('stays as it was with the switch off: two ranges, no comparison, a 30-day chart', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    url === GRAPHQL ? loads(0, 0) : Response.json({ data: answers(String(init?.body)) }),
  );
  const result = await siteTraffic(configured, '7d', 'humans', fetcher as unknown as typeof fetch, NOW);
  if (!result.ok) throw new Error('no report');
  const { ranges, previous, series, bucket } = result.traffic;
  expect([ranges, previous, series.length, bucket]).toEqual([['7d', '30d'], null, 30, 'day']);
  expect(fetcher.mock.calls.filter(([url]) => url !== GRAPHQL)).toHaveLength(9);
});

it('never reads more pings than page requests as negative bots', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === GRAPHQL) return loads(0, 0);
    const body = String(init?.body);
    return body.includes('blob1 IN') && !body.includes('AS bucket')
      ? Response.json({ data: [{ event: 'ping', class: 'human', count: 5 }] })
      : sqlRows(body);
  });
  const result = await siteTraffic(configured, '7d', 'bots', fetcher as unknown as typeof fetch);
  expect(result.ok && result.traffic.headline.bots).toBe(0);
  expect(result.ok && result.traffic.class).toBe('bots');
});

it('reports a missing configuration or a failed query without leaking the token', async () => {
  const never = vi.fn();
  for (const missing of ['CF_ACCOUNT_ID', 'SITE_EVENTS_DATASET', 'ANALYTICS_READ_TOKEN'] as const)
    expect(
      await siteTraffic({ ...configured, [missing]: undefined }, '7d', 'humans', never as unknown as typeof fetch),
    ).toEqual({ ok: false, reason: 'not_configured' });
  expect(never).not.toHaveBeenCalled();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const refused = vi.fn(async () => new Response('{"errors":[{"message":"bad token"}]}', { status: 403 }));
  expect(await siteTraffic(configured, '7d', 'humans', refused as unknown as typeof fetch)).toEqual({
    ok: false,
    reason: 'query_failed',
  });
  const malformed = vi.fn(async () => Response.json({ data: 'nope' }));
  expect(await siteTraffic(configured, '7d', 'humans', malformed as unknown as typeof fetch)).toEqual({
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
  const result = await siteTraffic(configured, '7d', 'humans', fetcher as unknown as typeof fetch);
  expect(result.ok && result.traffic.classed_since).toBe(null);
  expect(result.ok && result.traffic.headline.humans).toBe(0);
});

it('says when requests are not being counted here', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    url === GRAPHQL ? loads(0, 0) : sqlRows(String(init?.body)),
  );
  const off = { ...configured, TRAFFIC_EVENTS: 'off' } as unknown as Env;
  const result = await siteTraffic(off, '7d', 'humans', fetcher as unknown as typeof fetch);
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
  await siteTraffic(configured, '7d', 'humans', fetcher as unknown as typeof fetch);
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
    const result = await siteTraffic(configured, '7d', 'humans', fetcher as unknown as typeof fetch);
    expect(result.ok && result.traffic.web_analytics).toEqual({ ok: false, reason: 'query_failed' });
  }
  const unset = vi.fn(async (_url: string, init?: RequestInit) => sqlRows(String(init?.body)));
  const noOrigin = await siteTraffic(
    { ...configured, WEB_ORIGIN: undefined },
    '7d',
    'humans',
    unset as unknown as typeof fetch,
  );
  expect(noOrigin.ok && noOrigin.traffic.web_analytics).toEqual({ ok: false, reason: 'not_configured' });
  expect(unset.mock.calls.map(([url]) => url)).not.toContain(GRAPHQL);
  expect(JSON.stringify(errors.mock.calls)).not.toContain('test-read-token');
  errors.mockRestore();
});
