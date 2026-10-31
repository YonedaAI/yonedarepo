// The Traffic page's Analytics Engine SQL, one statement per section. Who a list counts:
// Humans are pings; Agents are page requests from self-identified AI user agents; Bots are the
// other page requests less the pings that confirmed some of them. A signed-in page request is
// never recorded, so a signed-in ping confirms nothing. Points from before classes, and platform
// points from before our tools were marked, count nowhere. Counts sum `_sample_interval`, so they
// stay right when Analytics Engine samples, and platform points multiply in their own weight.
import type { TrafficClass, TrafficWindow } from '../../shared/site-traffic';
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

export type QueryName =
  | 'by_day'
  | 'totals'
  | 'classed_since'
  | 'top_pages'
  | 'top_referrers'
  | 'countries'
  | 'clients'
  | 'campaigns'
  | 'signups_7'
  | 'signups_30';

const PING = `${B.event} = 'ping'`;
const PAGE = `${B.event} = 'pageview'`;
const CLASSED_PAGE = `${PAGE} AND ${SITE_EVENT_CLASSED} = 1`;
const CLIENT = `${B.event} = 'client' AND ${SITE_EVENT_MARKED} = 1`;
const COUNT = 'SUM(_sample_interval)';
const LISTS: Record<TrafficClass, { where: string; count: string; having: string }> = {
  humans: { where: PING, count: COUNT, having: '' },
  agents: { where: `${PAGE} AND ${B.class} = 'agent'`, count: COUNT, having: '' },
  bots: {
    where: `((${PING} AND ${B.class} = 'human') OR (${CLASSED_PAGE} AND ${B.class} != 'agent'))`,
    count: `SUM(_sample_interval * if(${PING}, -1, 1))`,
    having: ' HAVING count > 0',
  },
};

/** The report's SQL for the last `days` days, with its top lists for `who`. */
export function trafficQueries(
  dataset: string,
  days: TrafficWindow,
  who: TrafficClass,
): Record<QueryName, string> {
  if (!DATASET.test(dataset)) throw new Error('Invalid Analytics Engine dataset name');
  if (days !== 7 && days !== 30) throw new Error('Invalid traffic window');
  const since = (n: number) => `timestamp > NOW() - INTERVAL '${n}' DAY`;
  const list = LISTS[who];
  const top = (blob: string, extra = '') =>
    `SELECT ${blob} AS key, ${list.count} AS count FROM ${dataset} WHERE ${list.where} AND ${since(days)}${extra} GROUP BY key${list.having} ORDER BY count DESC LIMIT ${TOP} FORMAT JSON`;
  const weighted = `SUM(_sample_interval * if(${B.event} = 'client', ${SITE_EVENT_WEIGHT}, 1.0)) AS count`;
  const events = `${B.event} IN ('pageview', 'ping', 'client') AND ${SITE_EVENT_CLASSED} = 1 AND (${B.event} != 'client' OR ${SITE_EVENT_MARKED} = 1)`;
  const signups = (n: number) =>
    `SELECT ${B.provider} AS provider, ${B.referrer} AS referrer, ${B.utmSource} AS utm_source, ${B.utmCampaign} AS utm_campaign, SUM(_sample_interval) AS count FROM ${dataset} WHERE ${B.event} = 'signup' AND ${since(n)} GROUP BY provider, referrer, utm_source, utm_campaign ORDER BY count DESC LIMIT ${TOP} FORMAT JSON`;
  return {
    by_day: `SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS day, ${B.event} AS event, ${B.class} AS class, ${weighted} FROM ${dataset} WHERE ${events} AND ${since(30)} GROUP BY day, event, class ORDER BY day ASC FORMAT JSON`,
    totals: `SELECT ${B.event} AS event, ${B.class} AS class, ${weighted} FROM ${dataset} WHERE ${events} AND ${since(days)} GROUP BY event, class FORMAT JSON`,
    classed_since: `SELECT MIN(timestamp) AS since FROM ${dataset} WHERE ${PAGE} AND ${SITE_EVENT_CLASSED} = 1 FORMAT JSON`,
    top_pages: top(B.path),
    top_referrers: top(B.referrer, ` AND ${B.referrer} != ''`),
    countries: top(B.country, ` AND ${B.country} != ''`),
    clients: `SELECT ${B.client} AS client, ${B.operation} AS operation, SUM(_sample_interval * ${SITE_EVENT_WEIGHT}) AS count, SUM(_sample_interval * ${SITE_EVENT_WEIGHT} * ${SITE_EVENT_TOKEN}) AS with_token FROM ${dataset} WHERE ${CLIENT} AND ${since(days)} GROUP BY client, operation ORDER BY count DESC LIMIT ${TOP} FORMAT JSON`,
    campaigns: `SELECT ${B.utmSource} AS utm_source, ${B.utmMedium} AS utm_medium, ${B.utmCampaign} AS utm_campaign, SUM(_sample_interval) AS count FROM ${dataset} WHERE ${PAGE} AND ${SITE_EVENT_BOT} = 0 AND ${since(days)} AND (${B.utmSource} != '' OR ${B.utmMedium} != '' OR ${B.utmCampaign} != '') GROUP BY utm_source, utm_medium, utm_campaign ORDER BY count DESC LIMIT ${TOP} FORMAT JSON`,
    signups_7: signups(7),
    signups_30: signups(30),
  };
}
