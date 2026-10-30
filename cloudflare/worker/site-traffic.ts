// Site traffic reports (platform Worker, for the admin Traffic page): reads the front Worker's
// cookieless site events (site-events.ts) back through the Analytics Engine SQL API with an
// Account Analytics Read token. Bot-flagged page views are left out; sign-ups are real accounts
// and all count. Counts sum `_sample_interval`, so they stay right when Analytics Engine samples.
import type {
  SiteTraffic,
  SiteTrafficResult,
  TrafficCampaign,
  TrafficCount,
  TrafficSignupSource,
  TrafficWindow,
} from '../../shared/site-traffic';
import { SITE_EVENT_BLOBS as B, SITE_EVENT_BOT } from './site-events';
import type { Env } from './types';

// Interpolated into SQL as the table name: only an ordinary identifier is accepted.
const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ACCOUNT = /^[a-f0-9]{32}$/;
const TOP = 25;

type QueryName =
  | 'views_by_day'
  | 'top_pages'
  | 'top_referrers'
  | 'countries'
  | 'campaigns'
  | 'signups_7'
  | 'signups_30';
type Row = Record<string, unknown>;

/** The report's SQL, one statement per section. */
export function trafficQueries(dataset: string, days: TrafficWindow): Record<QueryName, string> {
  if (!DATASET.test(dataset)) throw new Error('Invalid Analytics Engine dataset name');
  if (days !== 7 && days !== 30) throw new Error('Invalid traffic window');
  const since = (n: number) => `timestamp > NOW() - INTERVAL '${n}' DAY`;
  const views = `${B.event} = 'pageview' AND ${SITE_EVENT_BOT} = 0`;
  const top = (blob: string, extra = '') =>
    `SELECT ${blob} AS key, SUM(_sample_interval) AS count FROM ${dataset} WHERE ${views} AND ${since(days)}${extra} GROUP BY key ORDER BY count DESC LIMIT ${TOP} FORMAT JSON`;
  const signups = (n: number) =>
    `SELECT ${B.provider} AS provider, ${B.referrer} AS referrer, ${B.utmSource} AS utm_source, ${B.utmCampaign} AS utm_campaign, SUM(_sample_interval) AS count FROM ${dataset} WHERE ${B.event} = 'signup' AND ${since(n)} GROUP BY provider, referrer, utm_source, utm_campaign ORDER BY count DESC LIMIT ${TOP} FORMAT JSON`;
  return {
    views_by_day: `SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS day, SUM(_sample_interval) AS views FROM ${dataset} WHERE ${views} AND ${since(30)} GROUP BY day ORDER BY day ASC FORMAT JSON`,
    top_pages: top(B.path),
    top_referrers: top(B.referrer, ` AND ${B.referrer} != ''`),
    countries: top(B.country, ` AND ${B.country} != ''`),
    campaigns: `SELECT ${B.utmSource} AS utm_source, ${B.utmMedium} AS utm_medium, ${B.utmCampaign} AS utm_campaign, SUM(_sample_interval) AS count FROM ${dataset} WHERE ${views} AND ${since(days)} AND (${B.utmSource} != '' OR ${B.utmMedium} != '' OR ${B.utmCampaign} != '') GROUP BY utm_source, utm_medium, utm_campaign ORDER BY count DESC LIMIT ${TOP} FORMAT JSON`,
    signups_7: signups(7),
    signups_30: signups(30),
  };
}

/** The Traffic page's report for the last `days` days (views by day always covers 30). */
export async function siteTraffic(
  env: Env,
  days: TrafficWindow,
  fetcher: typeof fetch = fetch,
): Promise<SiteTrafficResult> {
  const account = env.CF_ACCOUNT_ID ?? '';
  const dataset = env.SITE_EVENTS_DATASET ?? '';
  const token = env.ANALYTICS_READ_TOKEN ?? '';
  if (!ACCOUNT.test(account) || !DATASET.test(dataset) || !token)
    return { ok: false, reason: 'not_configured' };
  const queries = trafficQueries(dataset, days);
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
    const answers = await Promise.all(names.map((name) => run(queries[name])));
    const rows = Object.fromEntries(names.map((name, i) => [name, answers[i]])) as Record<
      QueryName,
      Row[]
    >;
    const traffic: SiteTraffic = {
      days,
      views_by_day: rows.views_by_day.map((r) => ({ day: text(r.day), views: num(r.views) })),
      top_pages: rows.top_pages.map(count),
      top_referrers: rows.top_referrers.map(count),
      countries: rows.countries.map(count),
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
const count = (r: Row): TrafficCount => ({ key: text(r.key), count: num(r.count) });
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
