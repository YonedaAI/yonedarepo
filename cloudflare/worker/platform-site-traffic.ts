// Site traffic reports (platform Worker, for the admin Traffic page): reads the cookieless events
// (site-events.ts, platform-client-events.ts) back through the Analytics Engine SQL API with an
// Account Analytics Read token, as humans, agents and bots (platform-traffic-queries.ts). A page
// request and its ping can't be joined, nothing identifies a visitor, so bots are page requests
// less pings. Web Analytics' own numbers (platform-web-analytics.ts) come along as a cross-check.
import {
  RANGE_DAYS,
  type SiteTraffic,
  type SiteTrafficResult,
  TRAFFIC_RANGES,
  type TrafficBucketCounts,
  type TrafficCampaign,
  type TrafficClass,
  type TrafficClient,
  type TrafficCount,
  type TrafficHeadline,
  type TrafficRange,
  type TrafficSignupSource,
} from '../../shared/site-traffic';
import { log } from './log';
import {
  type QueryName,
  type TrafficSpan,
  trafficQueries,
  trafficSpan,
} from './platform-traffic-queries';
import { webAnalytics } from './platform-web-analytics';
import type { Env } from './types';

// Interpolated into SQL as the table name: only an ordinary identifier is accepted.
const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ACCOUNT = /^[a-f0-9]{32}$/;

type Row = Record<string, unknown>;

/** The filter's class from a query parameter; Humans unless it names another. */
export const trafficClass = (value: string | null): TrafficClass =>
  value === 'agents' || value === 'bots' ? value : 'humans';

/** The ranges this platform offers. Without TRAFFIC_REPORT: today's two, with no comparison and
 * a chart of 30 days. */
const rangesOf = (env: Env): TrafficRange[] =>
  env.TRAFFIC_REPORT === 'on' ? TRAFFIC_RANGES : ['7d', '30d'];

/** The range from a query parameter; 30 days unless it names one offered here. */
export const trafficRange = (env: Env, value: string | null): TrafficRange =>
  rangesOf(env).find((range) => range === value) ?? '30d';

/** The report a `GET traffic` asks for. */
export const trafficReport = (env: Env, query: URLSearchParams) =>
  siteTraffic(env, trafficRange(env, query.get('range')), trafficClass(query.get('class')));

/** The Traffic page's report over `range`, ending `now`. */
export async function siteTraffic(
  env: Env,
  range: TrafficRange,
  who: TrafficClass,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<SiteTrafficResult> {
  const account = env.CF_ACCOUNT_ID ?? '';
  const dataset = env.SITE_EVENTS_DATASET ?? '';
  const token = env.ANALYTICS_READ_TOKEN ?? '';
  if (!ACCOUNT.test(account) || !DATASET.test(dataset) || !token)
    return { ok: false, reason: 'not_configured' };
  const full = env.TRAFFIC_REPORT === 'on';
  const span = trafficSpan(range, now);
  const chart = full ? span : trafficSpan('30d', now);
  const queries = trafficQueries(dataset, span, who, { chart, compare: full });
  const run = async (sql: string): Promise<Row[]> => {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: sql },
    );
    if (!response.ok) throw new Error(`Analytics Engine SQL API answered ${response.status}`);
    const data = ((await response.json()) as { data?: unknown }).data;
    if (!Array.isArray(data)) throw new Error('Analytics Engine SQL API answered without data');
    return data as Row[];
  };
  try {
    const names = Object.keys(queries) as QueryName[];
    const answers = await Promise.all(names.map((name) => run(queries[name] ?? '')));
    const rows = Object.fromEntries(names.map((name, i) => [name, answers[i]])) as Record<
      Exclude<QueryName, 'previous'>,
      Row[]
    > & { previous?: Row[] };
    const counted = classedAt(rows.classed_since[0]);
    const days = RANGE_DAYS[range];
    // Web Analytics is the witness for Humans, so it only speaks for the time they were counted.
    const web_analytics = await webAnalytics(
      env,
      days,
      fetcher,
      now,
      Math.max(counted, span.start),
    );
    const whole = span.previous_start !== null && counted > 0 && counted <= span.previous_start;
    const traffic: SiteTraffic = {
      range,
      ranges: rangesOf(env),
      days,
      class: who,
      classed_since: classedSince(rows.classed_since[0]),
      counting: env.TRAFFIC_EVENTS === 'on',
      headline: headline(rows.totals),
      previous: rows.previous && whole ? headline(rows.previous) : null,
      web_analytics,
      bucket: chart.bucket,
      series: series(rows.series, chart),
      top_pages: rows.top_pages.map(count),
      top_referrers: rows.top_referrers.map(count),
      countries: rows.countries.map(count),
      clients: rows.clients.map(client),
      campaigns: rows.campaigns.map(campaign),
      signups: rows.signups.map(signup),
    };
    return { ok: true, traffic };
  } catch (e) {
    log.error('site_traffic.failed', { error: e });
    return { ok: false, reason: 'query_failed' };
  }
}

// Analytics Engine answers 64-bit sums as strings (ClickHouse JSON), smaller ones as numbers.
const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
// With no matching row the SQL API answers MIN(timestamp) as the epoch, not as no rows.
const classedSince = (r: Row | undefined) => {
  const day = text(r?.since).slice(0, 10);
  return day && !day.startsWith('1970') ? day : null;
};
/** The earliest classed point as epoch milliseconds, 0 when there is none. */
const classedAt = (r: Row | undefined) => {
  const at = Date.parse(`${text(r?.since).replace(' ', 'T')}Z`);
  return classedSince(r) && Number.isFinite(at) ? at : 0;
};
const estimated = (r: Row) => num(r.sampling) > 1;
const count = (r: Row): TrafficCount => ({
  key: text(r.key),
  count: num(r.count),
  estimated: estimated(r),
});
const client = (r: Row): TrafficClient => ({
  client: text(r.client),
  operation: text(r.operation),
  count: num(r.count),
  with_token: num(r.with_token),
  estimated: estimated(r),
});

/** Folds rows of event, class and count. Signed-out pings confirm page requests, so they leave
 * the bots; a signed-in page request was never recorded. */
function headline(rows: Row[]): TrafficHeadline {
  const sum = (test: (r: Row) => boolean) =>
    rows.filter(test).reduce((total, r) => total + num(r.count), 0);
  const page = (r: Row) => r.event === 'pageview';
  const pings = (r: Row) => r.event === 'ping';
  const agents = (r: Row) => r.event === 'client' || (page(r) && r.class === 'agent');
  const others = (r: Row) => (page(r) && r.class !== 'agent') || (pings(r) && r.class === 'human');
  const humans = sum(pings);
  const humans_signed_in = sum((r) => pings(r) && r.class === 'signed_in');
  const classes: [TrafficClass, (r: Row) => boolean][] = [
    ['humans', pings],
    ['agents', agents],
    ['bots', others],
  ];
  return {
    humans,
    humans_signed_in,
    agents_site: sum((r) => page(r) && r.class === 'agent'),
    agents_platform: sum((r) => r.event === 'client'),
    bots: Math.max(sum((r) => page(r) && r.class !== 'agent') - (humans - humans_signed_in), 0),
    crawlers: sum((r) => page(r) && r.class === 'crawler'),
    estimated: classes
      .filter(([, test]) => rows.some((r) => test(r) && estimated(r)))
      .map(([name]) => name),
  };
}

/** Rows by hour or day, folded into `span`'s bars, counted back from its end. */
function series(rows: Row[], span: TrafficSpan): TrafficBucketCounts[] {
  const bars = Array.from({ length: span.buckets }, () => [] as Row[]);
  const last = span.buckets - 1;
  for (const r of rows) {
    const at = Date.parse(`${text(r.bucket)}:00:00Z`);
    bars[last - Math.floor((span.close - 1 - at) / span.bucket_ms)]?.push(r);
  }
  return bars.map((bar, i) => {
    const end = span.close - (last - i) * span.bucket_ms;
    const h = headline(bar);
    return {
      start: new Date(Math.max(end - span.bucket_ms, span.start)).toISOString(),
      end: new Date(end).toISOString(),
      humans: h.humans,
      agents: h.agents_site + h.agents_platform,
      bots: h.bots,
      estimated: h.estimated,
    };
  });
}

const campaign = (r: Row): TrafficCampaign => ({
  utm_source: text(r.utm_source),
  utm_medium: text(r.utm_medium),
  utm_campaign: text(r.utm_campaign),
  count: num(r.count),
  estimated: estimated(r),
});
const signup = (r: Row): TrafficSignupSource => ({
  provider: text(r.provider),
  referrer: text(r.referrer),
  utm_source: text(r.utm_source),
  utm_campaign: text(r.utm_campaign),
  count: num(r.count),
  estimated: estimated(r),
});
