// `GET /admin/service-levels`: the measured operations and the synthetic checks over the last 30
// days, read back from Analytics Engine for the Infrastructure tab. It states values and sets no
// target: docs/observability-plan.md says what each number means. Our tools are kept apart from
// everyone else, and a row's counts are estimates whenever Analytics Engine or we sampled.
import {
  MEASURING_DAYS,
  type ProbeRow,
  SERVICE_EVERY,
  SERVICE_OPERATIONS,
  type ServiceLevels,
  type ServiceLevelsResult,
  type ServiceOperation,
  type ServiceRow,
} from '../../shared/service-levels';
import { log } from './log';
import { num, type SqlRow, sqlReader, text } from './platform-analytics-sql';
import type { Env } from './types';

const DAY_MS = 86_400_000;

/** The three statements of one view. Only `dataset`, checked by sqlReader, and a number reach them. */
export function serviceQueries(dataset: string, start: number) {
  const since = `timestamp >= toDateTime(${Math.floor(start / 1000)})`;
  const measured = `blob1 = 'spans' AND blob5 != '' AND double3 > 0 AND ${since}`;
  const quantile = (q: number) => `quantileExactWeighted(${q})(double1, _sample_interval)`;
  return {
    counts: `SELECT blob5 AS operation, blob4 AS own, blob6 AS class, SUM(_sample_interval * double3) AS count, MAX(_sample_interval) AS sampling, MIN(timestamp) AS since FROM ${dataset} WHERE ${measured} GROUP BY operation, own, class FORMAT JSON`,
    latency: `SELECT blob5 AS operation, blob4 AS own, ${quantile(0.5)} AS p50, ${quantile(0.95)} AS p95, ${quantile(0.99)} AS p99 FROM ${dataset} WHERE ${measured} AND blob6 = 'ok' GROUP BY operation, own FORMAT JSON`,
    probes: `SELECT blob2 AS name, blob4 AS class, SUM(_sample_interval) AS count, ${quantile(0.5)} AS p50, ${quantile(0.95)} AS p95 FROM ${dataset} WHERE blob1 = 'probe' AND ${since} GROUP BY name, class FORMAT JSON`,
  };
}

const atMs = (row: SqlRow) => Date.parse(`${text(row.since).replace(' ', 'T')}Z`);

function rowsFor(counts: SqlRow[], latency: SqlRow[], own: string): ServiceRow[] {
  const mine = (r: SqlRow) => text(r.own) === own;
  return SERVICE_OPERATIONS.map((operation: ServiceOperation) => {
    const here = (r: SqlRow) => mine(r) && text(r.operation) === operation;
    const rows = counts.filter(here);
    const of = (name: string) =>
      rows.filter((r) => text(r.class) === name).reduce((n, r) => n + num(r.count), 0);
    const [good, refused, failed] = [of('ok'), of('refused'), of('failed')];
    const times = latency.find(here);
    return {
      operation,
      requests: good + refused + failed,
      failed,
      failure_rate: good + failed ? failed / (good + failed) : null,
      latency: times ? { p50: num(times.p50), p95: num(times.p95), p99: num(times.p99) } : null,
      estimated: SERVICE_EVERY[operation] > 1 || rows.some((r) => num(r.sampling) > 1),
    };
  });
}

function probeRows(rows: SqlRow[]): ProbeRow[] {
  const checks = [...new Set(rows.map((r) => text(r.name)))].sort();
  return checks.map((check) => {
    const of = (name: string) => rows.find((r) => text(r.name) === check && text(r.class) === name);
    const [good, failed] = [of('ok'), of('failed')];
    return {
      check,
      runs: num(good?.count) + num(failed?.count),
      failed: num(failed?.count),
      latency: good ? { p50: num(good.p50), p95: num(good.p95) } : null,
    };
  });
}

/** Whole days since the first point in the window, this one counted. */
function daysMeasured(rows: SqlRow[], now: number) {
  const first = Math.min(...rows.map(atMs).filter(Number.isFinite));
  if (!Number.isFinite(first)) return 0;
  return Math.min(Math.ceil((now - first) / DAY_MS), MEASURING_DAYS);
}

export async function serviceLevels(
  env: Env,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<ServiceLevelsResult> {
  if (env.SERVICE_LEVELS !== 'on') return { ok: false, reason: 'off' };
  const sql = sqlReader(env, fetcher);
  if (!sql) return { ok: false, reason: 'not_configured' };
  const queries = serviceQueries(sql.dataset, now - MEASURING_DAYS * DAY_MS);
  try {
    const [counts, latency, probes] = await Promise.all([
      sql.run(queries.counts),
      sql.run(queries.latency),
      sql.run(queries.probes),
    ]);
    const report: ServiceLevels = {
      days_measured: daysMeasured(counts, now),
      people: rowsFor(counts, latency, ''),
      ours: rowsFor(counts, latency, 'own'),
      outside: probeRows(probes),
    };
    return { ok: true, report };
  } catch (e) {
    log.error('service_levels.failed', { error: e });
    return { ok: false, reason: 'query_failed' };
  }
}
