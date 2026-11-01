// The admin Visitors tab (VISITORS): browsers, visits and pages from the pings that carry a day's
// hash (site-visitors.ts), and the way from a visit to a landing from D1. The hash is the point's
// index, because Analytics Engine keeps a busy index thin and only the index is safe to count by.
// One statement gives everything: a row for each browser and half hour on the clock, its first and
// last page, and the rest folded here, so no COUNT(DISTINCT) is relied on. Budget:
// docs/load-testing.md.
import type {
  FunnelStep,
  VisitorCount,
  VisitorReport,
  VisitorResult,
} from '../../shared/platform-reports';
import { TRAFFIC_RANGES, type TrafficRange } from '../../shared/site-traffic';
import { log } from './log';
import { num, type SqlRow, sqlReader, text } from './platform-analytics-sql';
import { type TrafficSpan, trafficSpan } from './platform-traffic-queries';
import { SITE_EVENT_BLOBS as B, SITE_EVENT_CLASSED } from './site-events';
import type { Env } from './types';

const LIMIT = 20_000;
const TOP = 10;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

const rangeOf = (value: string | null): TrafficRange =>
  TRAFFIC_RANGES.find((range) => range === value) ?? '30d';

export function visitorQuery(dataset: string, span: TrafficSpan) {
  const first = (blob: string, name: string) => `argMin(${blob}, timestamp) AS ${name}`;
  const figures = [
    `argMin(${B.path}, timestamp) AS entry`,
    `argMax(${B.path}, timestamp) AS exit`,
    first(B.referrer, 'referrer'),
    first(B.country, 'country'),
    first(B.device, 'device'),
    first(B.browser, 'browser'),
    'SUM(_sample_interval) AS views',
    `SUM(_sample_interval * if(startsWith(${B.path}, '/docs'), 1, 0)) AS docs`,
    'MAX(_sample_interval) AS sampling',
  ];
  const slot = `toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '30' MINUTE))`;
  const since = `timestamp >= toDateTime(${Math.floor(span.start / 1000)})`;
  return `SELECT index1 AS visitor, ${slot} AS slot, ${figures.join(', ')} FROM ${dataset} WHERE ${B.event} = 'ping' AND ${SITE_EVENT_CLASSED} = 1 AND ${B.browser} != '' AND ${since} GROUP BY visitor, slot ORDER BY slot DESC LIMIT ${LIMIT} FORMAT JSON`;
}

function top(rows: SqlRow[], key: string, estimated: boolean): VisitorCount[] {
  const found = new Map<string, number>();
  for (const r of rows) {
    const name = text(r[key]);
    if (name) found.set(name, (found.get(name) ?? 0) + 1);
  }
  return [...found]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP)
    .map(([name, count]) => ({ key: name, count, estimated }));
}

type Steps = Pick<VisitorReport, 'funnel' | 'retention' | 'campaigns'>;

/** One row per browser and half hour, folded. A hash lasts a day, so uniques are per day. */
export function foldVisitors(rows: SqlRow[], span: TrafficSpan) {
  const estimated = rows.length >= LIMIT || rows.some((r) => num(r.sampling) > 1);
  const last = span.buckets - 1;
  const bars = Array.from({ length: span.buckets }, () => new Set<string>());
  const days = new Set<string>();
  const docs = new Set<string>();
  let views = 0;
  for (const r of rows) {
    const at = num(r.slot) * 1000;
    const day = `${Math.floor(at / DAY_MS)}:${text(r.visitor)}`;
    days.add(day);
    if (num(r.docs) > 0) docs.add(day);
    views += num(r.views);
    bars[last - Math.floor((span.close - 1 - at) / span.bucket_ms)]?.add(day);
  }
  return {
    range: span.range,
    visitors: days.size,
    docs: docs.size,
    sessions: rows.length,
    views,
    estimated,
    bucket: span.bucket,
    series: bars.map((bar, i) => {
      const end = span.close - (last - i) * span.bucket_ms;
      return {
        start: new Date(Math.max(end - span.bucket_ms, span.start)).toISOString(),
        end: new Date(end).toISOString(),
        visitors: bar.size,
        estimated,
      };
    }),
    entries: top(rows, 'entry', estimated),
    exits: top(rows, 'exit', estimated),
    referrers: top(rows, 'referrer', estimated),
    countries: top(rows, 'country', estimated),
    devices: top(rows, 'device', estimated),
    browsers: top(rows, 'browser', estimated),
  };
}

const OWNS_REPO = 'EXISTS(SELECT 1 FROM platform_repos r WHERE r.workspace=a.account)';
const activity = (condition: string) =>
  `EXISTS(SELECT 1 FROM platform_repos r JOIN platform_activity x ON x.repo=r.id
     WHERE r.workspace=a.account AND ${condition})`;

/** The steps after a visit, for accounts made since `from`. Activity is what the Home last kept,
 * so a repository nobody has looked at lately can read behind. */
async function accountSteps(env: Env, from: number, now: number) {
  const THEIRS = 'a.created_at>=?1 AND a.internal=0';
  const [funnel, retention, campaigns] = await env.INDEX.batch<Record<string, unknown>>([
    env.INDEX.prepare(
      `SELECT COUNT(*) AS signups, COALESCE(SUM(${OWNS_REPO}),0) AS repositories,
         COALESCE(SUM(${activity("json_extract(x.summary,'$.pushed')=1")}),0) AS pushed,
         COALESCE(SUM(${activity("json_extract(x.summary,'$.changes_landed_total')>0")}),0) AS landed
         FROM platform_accounts a WHERE ${THEIRS}`,
    ).bind(from),
    env.INDEX.prepare(
      `SELECT COUNT(*) AS cohort, COALESCE(SUM(a.last_seen_at>=a.created_at+${WEEK_MS}),0) AS returned
         FROM platform_accounts a WHERE ${THEIRS} AND a.created_at<?2`,
    ).bind(from, now - WEEK_MS),
    env.INDEX.prepare(
      `SELECT COALESCE(NULLIF(a.signup_utm_source,''),NULLIF(a.signup_ref,''),'') AS key,
         COUNT(*) AS signups, COALESCE(SUM(${OWNS_REPO}),0) AS repositories
         FROM platform_accounts a WHERE ${THEIRS} GROUP BY key ORDER BY signups DESC LIMIT ${TOP}`,
    ).bind(from),
  ]);
  return {
    funnel: (funnel.results[0] ?? {}) as Record<string, number>,
    retention: (retention.results[0] ?? {}) as Record<string, number>,
    campaigns: campaigns.results,
  };
}

/** `GET visitors?range=`. */
export async function visitorReport(
  env: Env,
  query: URLSearchParams,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<VisitorResult> {
  if (env.VISITORS !== 'on') return { ok: false, reason: 'off' };
  const sql = sqlReader(env, fetcher);
  if (!sql) return { ok: false, reason: 'not_configured' };
  const span = trafficSpan(rangeOf(query.get('range')), now);
  try {
    const [rows, steps] = await Promise.all([
      sql.run(visitorQuery(sql.dataset, span)),
      accountSteps(env, span.start, now),
    ]);
    const { docs, ...seen } = foldVisitors(rows, span);
    const counted = (step: FunnelStep['step'], count: number, estimated = false) => ({
      step,
      count,
      estimated,
    });
    const report: VisitorReport & Steps = {
      ...seen,
      funnel: [
        counted('visitors', seen.visitors, seen.estimated),
        counted('docs', docs, seen.estimated),
        counted('signups', num(steps.funnel.signups)),
        counted('repositories', num(steps.funnel.repositories)),
        counted('pushed', num(steps.funnel.pushed)),
        counted('landed', num(steps.funnel.landed)),
      ],
      retention: { cohort: num(steps.retention.cohort), returned: num(steps.retention.returned) },
      campaigns: steps.campaigns.map((c) => ({
        key: text(c.key),
        signups: num(c.signups),
        repositories: num(c.repositories),
      })),
    };
    return { ok: true, report };
  } catch (e) {
    log.error('visitor_report.failed', { error: e });
    return { ok: false, reason: 'query_failed' };
  }
}
