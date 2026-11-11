// The admin Operations tab (OPS_REPORT): how each operation went, for each kind of client, from
// the points recordClient writes. One statement a view. Budget: docs/load-testing.md.
import type { AdminReports, OperationRow, OperationsResult } from '../../shared/platform-reports';
import { TRAFFIC_RANGES, type TrafficRange } from '../../shared/site-traffic';
import { log } from './log';
import { num, type SqlRow, sqlReader, text } from './platform-analytics-sql';
import { type TrafficSpan, trafficSpan } from './platform-traffic-queries';
import { agentReport } from './repo-usage';
import {
  SITE_EVENT_BLOBS as B,
  SITE_EVENT_DURATION,
  SITE_EVENT_MARKED,
  SITE_EVENT_WEIGHT,
} from './site-events';
import type { Env } from './types';

export const opsOn = (env: Env) => env.OPS_REPORT === 'on';

/** Which optional tabs the admin pages offer here. */
export const adminReports = (env: Env): AdminReports => ({
  operations: opsOn(env),
  ...(env.OPERATION_METRICS === 'on' ? { measurements: true } : {}),
  visitors: env.VISITORS === 'on',
  agents: agentReport(env),
});

const rangeOf = (value: string | null): TrafficRange =>
  TRAFFIC_RANGES.find((range) => range === value) ?? '7d';

const OUTCOMES = ['success', 'failed', 'unauthorized', 'rate_limited'];

export function operationsQuery(dataset: string, span: TrafficSpan) {
  const weight = `_sample_interval * ${SITE_EVENT_WEIGHT}`;
  const outcomes = OUTCOMES.map((o) => `SUM(${weight} * if(${B.outcome} = '${o}', 1, 0)) AS ${o}`);
  const times = [0.5, 0.95, 0.99].map(
    (q) =>
      `quantileExactWeighted(${q})(${SITE_EVENT_DURATION}, _sample_interval) AS p${Math.round(q * 100)}`,
  );
  const figures = [`SUM(${weight}) AS count`, ...outcomes, ...times, `MAX(${weight}) AS sampling`];
  const since = `timestamp >= toDateTime(${Math.floor(span.start / 1000)})`;
  return `SELECT ${B.operation} AS operation, ${B.client} AS client, ${figures.join(', ')} FROM ${dataset} WHERE ${B.event} IN ('client', 'repo') AND ${SITE_EVENT_MARKED} = 1 AND ${B.outcome} != '' AND ${since} GROUP BY operation, client ORDER BY count DESC LIMIT 50 FORMAT JSON`;
}

const row = (r: SqlRow): OperationRow => ({
  operation: text(r.operation),
  client: text(r.client),
  count: num(r.count),
  success: num(r.success),
  failed: num(r.failed),
  unauthorized: num(r.unauthorized),
  rate_limited: num(r.rate_limited),
  p50: num(r.p50),
  p95: num(r.p95),
  p99: num(r.p99),
  estimated: num(r.sampling) > 1,
});

/** `GET operations?range=`. */
export async function operationsReport(
  env: Env,
  query: URLSearchParams,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<OperationsResult> {
  if (!opsOn(env)) return { ok: false, reason: 'off' };
  const sql = sqlReader(env, fetcher);
  if (!sql) return { ok: false, reason: 'not_configured' };
  const range = rangeOf(query.get('range'));
  try {
    const rows = await sql.run(operationsQuery(sql.dataset, trafficSpan(range, now)));
    return { ok: true, range, rows: rows.map(row) };
  } catch (e) {
    log.error('operations_report.failed', { error: e });
    return { ok: false, reason: 'query_failed' };
  }
}
