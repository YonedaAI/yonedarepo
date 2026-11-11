// Operator-only aggregates. Request ids and repository ids remain in private logs.
import {
  OPERATION_POINT,
  type OperationReport,
  type OperationRow,
} from '../../shared/operation-metrics';
import { capturePolicy } from './operation-context';
import { num, sqlReader, text } from './platform-analytics-sql';
import type { Env } from './types';

const RANGES: Record<string, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
};
const GROUP = 'blob2,blob3,blob4,blob5,blob6,blob7,blob8,blob9,blob10,blob11';
const LIMIT = 500;

export function operationQueries(dataset: string, start: number, query: URLSearchParams) {
  const filters = [
    `blob1 = '${OPERATION_POINT}'`,
    `timestamp >= toDateTime(${Math.floor(start / 1000)})`,
  ];
  for (const [key, column] of [
    ['component', 'blob11'],
    ['region', 'blob8'],
    ['revision', 'blob10'],
    ['kind', 'blob2'],
    ['operation', 'blob3'],
    ['source', 'blob4'],
    ['traffic', 'blob5'],
  ] as const) {
    const value = query.get(key);
    if (value && /^[A-Za-z0-9_:/ .-]{1,96}$/.test(value)) filters.push(`${column} = '${value}'`);
  }
  const where = filters.join(' AND ');
  const names =
    'blob2 AS kind,blob3 AS operation,blob4 AS source,blob5 AS traffic,blob6 AS actor,blob7 AS outcome,blob8 AS region,blob9 AS authority_region,blob10 AS revision,blob11 AS component';
  return {
    measurements: `SELECT ${names}, SUM(_sample_interval) AS requests, MAX(_sample_interval) AS sampling, quantileExactWeighted(0.5)(double1,_sample_interval) AS p50, quantileExactWeighted(0.95)(double1,_sample_interval) AS p95, quantileExactWeighted(0.99)(double1,_sample_interval) AS p99 FROM ${dataset} WHERE ${where} GROUP BY ${GROUP} ORDER BY requests DESC LIMIT ${LIMIT} FORMAT JSON`,
    queue: `SELECT ${names}, quantileExactWeighted(0.95)(double4,_sample_interval) AS queue_p95 FROM ${dataset} WHERE ${where} AND double4 >= 0 GROUP BY ${GROUP} LIMIT ${LIMIT} FORMAT JSON`,
  };
}

export async function operationReport(
  env: Env,
  query = new URLSearchParams(),
  fetcher = fetch,
  now = Date.now(),
): Promise<OperationReport> {
  const policy = capturePolicy(env, now);
  const window = { start: now - (RANGES[query.get('range') ?? '30d'] ?? RANGES['30d']), end: now };
  const empty: OperationReport = {
    rows: [],
    window,
    coverage: policy,
    status: policy.enabled ? 'unavailable' : 'off',
  };
  if (!policy.enabled) return empty;
  const reader = sqlReader(env, fetcher);
  if (!reader) return empty;
  try {
    const q = operationQueries(reader.dataset, window.start, query);
    const [measured, queued] = await Promise.all([reader.run(q.measurements), reader.run(q.queue)]);
    const key = (r: Record<string, unknown>) =>
      [
        'kind',
        'operation',
        'source',
        'traffic',
        'actor',
        'outcome',
        'region',
        'authority_region',
        'revision',
        'component',
      ]
        .map((k) => text(r[k]))
        .join('|');
    const finite = (v: unknown) =>
      v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;
    const waits = new Map(queued.map((r) => [key(r), finite(r.queue_p95)]));
    const rows = measured.map((r) => ({
      component: text(r.component),
      region: text(r.region),
      authorityRegion: text(r.authority_region),
      revision: text(r.revision),
      kind: text(r.kind),
      operation: text(r.operation),
      source: text(r.source),
      traffic: text(r.traffic),
      outcome: text(r.outcome),
      actor: text(r.actor),
      requests: num(r.requests),
      p50: finite(r.p50),
      p95: finite(r.p95),
      p99: finite(r.p99),
      estimated: num(r.sampling) > 1,
      queueWaitP95: waits.get(key(r)) ?? null,
    })) as OperationRow[];
    return {
      rows,
      window,
      coverage: { ...policy, truncated: measured.length === LIMIT },
      status: 'ok',
    };
  } catch {
    return empty;
  }
}
