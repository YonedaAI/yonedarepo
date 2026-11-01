// The Traffic page's Analytics Engine SQL, one statement per section, all over one window. Who a
// list counts: Humans are pings; Agents are page requests from self-identified AI user agents;
// Bots are the other page requests less the pings that confirmed some of them. A signed-in page
// request is never recorded, so a signed-in ping confirms nothing. Points from before classes, and
// platform points from before our tools were marked, count nowhere. Counts sum `_sample_interval`,
// so they stay right when Analytics Engine samples, and platform points multiply in their own
// weight. `sampling` is the most points one row stood for: above 1, the count is an estimate.
import {
  RANGE_DAYS,
  type TrafficBucket,
  type TrafficClass,
  type TrafficRange,
} from '../../shared/site-traffic';
import {
  SITE_EVENT_BLOBS as B,
  SITE_EVENT_BOT,
  SITE_EVENT_CLASSED,
  SITE_EVENT_MARKED,
  SITE_EVENT_TOKEN,
  SITE_EVENT_WEIGHT,
} from './site-events';

const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TOP = 25;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Analytics Engine keeps three months. */
const KEPT_MS = 90 * DAY_MS;

export type QueryName =
  | 'series'
  | 'totals'
  | 'previous'
  | 'classed_since'
  | 'top_pages'
  | 'top_referrers'
  | 'countries'
  | 'clients'
  | 'campaigns'
  | 'signups';
export type TrafficQueries = Partial<Record<QueryName, string>> &
  Record<Exclude<QueryName, 'previous'>, string>;

/** A range's window, in epoch milliseconds: it starts on a bucket and ends now. */
export type TrafficSpan = {
  range: TrafficRange;
  bucket: TrafficBucket;
  /** The bars, and how long each is. Weeks count back from today, so the first can be short. */
  buckets: number;
  bucket_ms: number;
  start: number;
  /** When the last bar ends: now, rounded up. */
  close: number;
  /** The period before, as long as this one so far; null when it's past what's kept. */
  previous_start: number | null;
};

const BUCKETS: Record<TrafficRange, { bucket: TrafficBucket; ms: number }> = {
  '24h': { bucket: 'hour', ms: HOUR_MS },
  '7d': { bucket: 'day', ms: DAY_MS },
  '30d': { bucket: 'day', ms: DAY_MS },
  '90d': { bucket: 'week', ms: 7 * DAY_MS },
};

export function trafficSpan(range: TrafficRange, now: number): TrafficSpan {
  const { bucket, ms } = BUCKETS[range];
  const step = bucket === 'hour' ? HOUR_MS : DAY_MS;
  const close = Math.floor(now / step) * step + step;
  const start = close - RANGE_DAYS[range] * DAY_MS;
  const before = start - (now - start);
  return {
    range,
    bucket,
    buckets: Math.ceil((close - start) / ms),
    bucket_ms: ms,
    start,
    close,
    previous_start: before >= now - KEPT_MS ? before : null,
  };
}

const PING = `${B.event} = 'ping'`;
const PAGE = `${B.event} = 'pageview'`;
const CLASSED_PAGE = `${PAGE} AND ${SITE_EVENT_CLASSED} = 1`;
const CLIENT = `${B.event} = 'client' AND ${SITE_EVENT_MARKED} = 1`;
const COUNT = 'SUM(_sample_interval)';
const SAMPLING = 'MAX(_sample_interval) AS sampling';
const LISTS: Record<TrafficClass, { where: string; count: string; having: string }> = {
  humans: { where: PING, count: COUNT, having: '' },
  agents: { where: `${PAGE} AND ${B.class} = 'agent'`, count: COUNT, having: '' },
  bots: {
    where: `((${PING} AND ${B.class} = 'human') OR (${CLASSED_PAGE} AND ${B.class} != 'agent'))`,
    count: `SUM(_sample_interval * if(${PING}, -1, 1))`,
    having: ' HAVING count > 0',
  },
};
const seconds = (ms: number) => Math.floor(ms / 1000);
const from = (ms: number) => `timestamp >= toDateTime(${seconds(ms)})`;
const until = (ms: number) => `timestamp < toDateTime(${seconds(ms)})`;

/** The report's SQL over `span`, with its top lists for `who`. `chart` is the window the chart
 * draws; `compare` asks for the period before. */
export function trafficQueries(
  dataset: string,
  span: TrafficSpan,
  who: TrafficClass,
  { chart = span, compare = true }: { chart?: TrafficSpan; compare?: boolean } = {},
): TrafficQueries {
  if (!DATASET.test(dataset)) throw new Error('Invalid Analytics Engine dataset name');
  const since = from(span.start);
  const list = LISTS[who];
  const top = (blob: string, extra = '') =>
    `SELECT ${blob} AS key, ${list.count} AS count, ${SAMPLING} FROM ${dataset} WHERE ${list.where} AND ${since}${extra} GROUP BY key${list.having} ORDER BY count DESC LIMIT ${TOP} FORMAT JSON`;
  const stands = `if(${B.event} = 'client', ${SITE_EVENT_WEIGHT}, 1.0)`;
  const weighted = `SUM(_sample_interval * ${stands}) AS count, MAX(_sample_interval * ${stands}) AS sampling`;
  const events = `${B.event} IN ('pageview', 'ping', 'client') AND ${SITE_EVENT_CLASSED} = 1 AND (${B.event} != 'client' OR ${SITE_EVENT_MARKED} = 1)`;
  const totals = (when: string) =>
    `SELECT ${B.event} AS event, ${B.class} AS class, ${weighted} FROM ${dataset} WHERE ${events} AND ${when} GROUP BY event, class FORMAT JSON`;
  // Weeks are days folded in the Worker: they count back from today, and SQL's weeks don't.
  const unit = chart.bucket === 'hour' ? 'HOUR' : 'DAY';
  const before = compare ? span.previous_start : null;
  return {
    series: `SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' ${unit}), '%Y-%m-%dT%H') AS bucket, ${B.event} AS event, ${B.class} AS class, ${weighted} FROM ${dataset} WHERE ${events} AND ${from(chart.start)} GROUP BY bucket, event, class ORDER BY bucket ASC FORMAT JSON`,
    totals: totals(since),
    ...(before !== null && { previous: totals(`${from(before)} AND ${until(span.start)}`) }),
    classed_since: `SELECT MIN(timestamp) AS since FROM ${dataset} WHERE ${PAGE} AND ${SITE_EVENT_CLASSED} = 1 FORMAT JSON`,
    top_pages: top(B.path),
    top_referrers: top(B.referrer, ` AND ${B.referrer} != ''`),
    countries: top(B.country, ` AND ${B.country} != ''`),
    clients: `SELECT ${B.client} AS client, ${B.operation} AS operation, SUM(_sample_interval * ${SITE_EVENT_WEIGHT}) AS count, SUM(_sample_interval * ${SITE_EVENT_WEIGHT} * ${SITE_EVENT_TOKEN}) AS with_token, MAX(_sample_interval * ${SITE_EVENT_WEIGHT}) AS sampling FROM ${dataset} WHERE ${CLIENT} AND ${since} GROUP BY client, operation ORDER BY count DESC LIMIT ${TOP} FORMAT JSON`,
    campaigns: `SELECT ${B.utmSource} AS utm_source, ${B.utmMedium} AS utm_medium, ${B.utmCampaign} AS utm_campaign, SUM(_sample_interval) AS count, ${SAMPLING} FROM ${dataset} WHERE ${PAGE} AND ${SITE_EVENT_BOT} = 0 AND ${since} AND (${B.utmSource} != '' OR ${B.utmMedium} != '' OR ${B.utmCampaign} != '') GROUP BY utm_source, utm_medium, utm_campaign ORDER BY count DESC LIMIT ${TOP} FORMAT JSON`,
    signups: `SELECT ${B.provider} AS provider, ${B.referrer} AS referrer, ${B.utmSource} AS utm_source, ${B.utmCampaign} AS utm_campaign, SUM(_sample_interval) AS count, ${SAMPLING} FROM ${dataset} WHERE ${B.event} = 'signup' AND ${since} GROUP BY provider, referrer, utm_source, utm_campaign ORDER BY count DESC LIMIT ${TOP} FORMAT JSON`,
  };
}
