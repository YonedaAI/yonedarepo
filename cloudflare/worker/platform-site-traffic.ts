// Site traffic reports (platform Worker, for the admin Traffic page): reads the cookieless events
// (site-events.ts, platform-client-events.ts) back through the Analytics Engine SQL API with an
// Account Analytics Read token, as humans, agents and bots (platform-traffic-queries.ts). A page
// request and its ping can't be joined, nothing identifies a visitor, so bots are page requests
// less pings. Web Analytics' own numbers (platform-web-analytics.ts) come along as a cross-check.
import type {
  SiteTraffic,
  SiteTrafficResult,
  TrafficCampaign,
  TrafficClass,
  TrafficClient,
  TrafficCount,
  TrafficHeadline,
  TrafficSignupSource,
  TrafficWindow,
} from '../../shared/site-traffic';
import { type QueryName, trafficQueries } from './platform-traffic-queries';
import { webAnalytics } from './platform-web-analytics';
import type { Env } from './types';

// Interpolated into SQL as the table name: only an ordinary identifier is accepted.
const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ACCOUNT = /^[a-f0-9]{32}$/;

type Row = Record<string, unknown>;

/** The filter's class from a query parameter; Humans unless it names another. */
export const trafficClass = (value: string | null): TrafficClass =>
  value === 'agents' || value === 'bots' ? value : 'humans';

/** The Traffic page's report for the last `days` days (views by day always covers 30). */
export async function siteTraffic(
  env: Env,
  days: TrafficWindow,
  who: TrafficClass,
  fetcher: typeof fetch = fetch,
): Promise<SiteTrafficResult> {
  const account = env.CF_ACCOUNT_ID ?? '';
  const dataset = env.SITE_EVENTS_DATASET ?? '';
  const token = env.ANALYTICS_READ_TOKEN ?? '';
  if (!ACCOUNT.test(account) || !DATASET.test(dataset) || !token)
    return { ok: false, reason: 'not_configured' };
  const queries = trafficQueries(dataset, days, who);
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
    const [answers, web_analytics] = await Promise.all([
      Promise.all(names.map((name) => run(queries[name]))),
      webAnalytics(env, days, fetcher),
    ]);
    const rows = Object.fromEntries(names.map((name, i) => [name, answers[i]])) as Record<
      QueryName,
      Row[]
    >;
    const traffic: SiteTraffic = {
      days,
      class: who,
      classed_since: classedSince(rows.classed_since[0]),
      headline: headline(rows.totals),
      web_analytics,
      by_day: byDay(rows.by_day),
      top_pages: rows.top_pages.map(count),
      top_referrers: rows.top_referrers.map(count),
      countries: rows.countries.map(count),
      clients: rows.clients.map(client),
      campaigns: rows.campaigns.map(campaign),
      signups: { last_7: rows.signups_7.map(signup), last_30: rows.signups_30.map(signup) },
    };
    return { ok: true, traffic };
  } catch (e) {
    console.error(
      JSON.stringify({ event: 'site_traffic.failed', error: String((e as Error)?.message ?? e) }),
    );
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
const count = (r: Row): TrafficCount => ({ key: text(r.key), count: num(r.count) });
const client = (r: Row): TrafficClient => ({
  client: text(r.client),
  operation: text(r.operation),
  count: num(r.count),
  with_token: num(r.with_token),
});

/** Folds rows of event, class and count. Pings confirm page requests, so they leave the bots. */
function headline(rows: Row[]): TrafficHeadline {
  const sum = (test: (r: Row) => boolean) =>
    rows.filter(test).reduce((total, r) => total + num(r.count), 0);
  const page = (r: Row) => r.event === 'pageview';
  const humans = sum((r) => r.event === 'ping');
  return {
    humans,
    agents_site: sum((r) => page(r) && r.class === 'agent'),
    agents_platform: sum((r) => r.event === 'client'),
    bots: Math.max(sum((r) => page(r) && r.class !== 'agent') - humans, 0),
    crawlers: sum((r) => page(r) && r.class === 'crawler'),
  };
}

function byDay(rows: Row[]) {
  const days = [...new Set(rows.map((r) => text(r.day)))].sort();
  return days.map((day) => {
    const h = headline(rows.filter((r) => r.day === day));
    return { day, humans: h.humans, agents: h.agents_site + h.agents_platform, bots: h.bots };
  });
}

const campaign = (r: Row): TrafficCampaign => ({
  utm_source: text(r.utm_source),
  utm_medium: text(r.utm_medium),
  utm_campaign: text(r.utm_campaign),
  count: num(r.count),
});
const signup = (r: Row): TrafficSignupSource => ({
  provider: text(r.provider),
  referrer: text(r.referrer),
  utm_source: text(r.utm_source),
  utm_campaign: text(r.utm_campaign),
  count: num(r.count),
});
