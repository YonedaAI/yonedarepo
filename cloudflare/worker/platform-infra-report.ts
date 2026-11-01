// The admin Infrastructure tab (OPS_REPORT): queues, Workers, D1 and R2 as Cloudflare's GraphQL
// Analytics API reports them, with the Account Analytics Read token the traffic reports use. Its
// figures arrive a few minutes late, so the window ends before now and the page says what it
// covers. One request per section: GraphQL refuses a whole query for one field, and a section that
// fails leaves the others up. Held a minute per isolate. Budget: docs/load-testing.md.
import type {
  Infrastructure,
  InfrastructureResult,
  QueueRow,
  Section,
  WorkerRow,
} from '../../shared/platform-reports';
import { log } from './log';
import { opsOn } from './platform-operations-report';
import type { Env } from './types';

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const INGEST_DELAY_MS = 5 * 60_000;
const WINDOW_MS = 60 * 60_000;
const WEEK_MS = 7 * 24 * WINDOW_MS;
const HELD_MS = 60_000;
const ACCOUNT = /^[a-f0-9]{32}$/;

type Row = Record<string, any>;
export type Resources = {
  scripts: string[];
  queues: Record<string, string>;
  d1: string;
  r2: string;
};

const QUEUES = `query Queues($account: string!, $start: Time!, $end: Time!, $queues: [string!]) {
  viewer { accounts(filter: { accountTag: $account }) {
    backlog: queueBacklogAdaptiveGroups(limit: 500, orderBy: [datetimeFiveMinutes_ASC], filter: { queueId_in: $queues, datetime_geq: $start, datetime_leq: $end }) {
      avg { messages } dimensions { queueId datetimeFiveMinutes } }
    ops: queueMessageOperationsAdaptiveGroups(limit: 500, filter: { queueId_in: $queues, datetime_geq: $start, datetime_leq: $end }) {
      sum { billableOperations } avg { lagTime retryCount } dimensions { queueId actionType outcome } }
  } } }`;
const WORKERS = `query Workers($account: string!, $start: Time!, $end: Time!, $scripts: [string!]) {
  viewer { accounts(filter: { accountTag: $account }) {
    workers: workersInvocationsAdaptive(limit: 50, filter: { scriptName_in: $scripts, datetime_geq: $start, datetime_leq: $end }) {
      sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { scriptName } }
  } } }`;
const DATABASE = `query Database($account: string!, $day: Date!, $d1: string!) {
  viewer { accounts(filter: { accountTag: $account }) {
    latency: d1AnalyticsAdaptiveGroups(limit: 1, filter: { databaseId: $d1, date_geq: $day }) {
      quantiles { queryBatchTimeMsP50 queryBatchTimeMsP90 } }
    size: d1StorageAdaptiveGroups(limit: 1, filter: { databaseId: $d1, date_geq: $day }) {
      max { databaseSizeBytes } }
  } } }`;
const STORAGE = `query Storage($account: string!, $week: Time!, $end: Time!, $r2: string!) {
  viewer { accounts(filter: { accountTag: $account }) {
    r2: r2StorageAdaptiveGroups(limit: 10000, orderBy: [datetime_ASC], filter: { bucketName: $r2, datetime_geq: $week, datetime_leq: $end }) {
      max { objectCount payloadSize } dimensions { datetime } }
  } } }`;

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

/** OPS_RESOURCES, or null when it isn't all there. */
export function resources(env: Env): Resources | null {
  try {
    const r = JSON.parse(env.OPS_RESOURCES ?? '') as Partial<Resources>;
    const queues = r?.queues && typeof r.queues === 'object' ? Object.values(r.queues) : null;
    if (!strings(r?.scripts) || !strings(queues)) return null;
    if (typeof r.d1 !== 'string' || typeof r.r2 !== 'string') return null;
    return r as Resources;
  } catch {
    return null;
  }
}

export function queueRows(account: Row, queues: Record<string, string>): QueueRow[] {
  return Object.entries(queues).map(([label, id]) => {
    const seen = (r: Row) => r.dimensions?.queueId === id;
    const reads = (account.ops as Row[])
      .filter(seen)
      .filter((r) => r.dimensions?.actionType !== 'WriteMessage');
    const worst = (key: string) => Math.max(0, ...reads.map((r) => num(r.avg?.[key])));
    return {
      label,
      backlog: num((account.backlog as Row[]).filter(seen).at(-1)?.avg?.messages),
      wait_ms: worst('lagTime'),
      retries: worst('retryCount'),
      dead_lettered: reads
        .filter((r) => r.dimensions?.outcome === 'dlq')
        .reduce((n, r) => n + num(r.sum?.billableOperations), 0),
      dead_letter_queue: label.includes('dead'),
    };
  });
}

export const workerRows = (account: Row): WorkerRow[] =>
  (account.workers as Row[])
    .map((r) => ({
      script: String(r.dimensions?.scriptName ?? ''),
      requests: num(r.sum?.requests),
      errors: num(r.sum?.errors),
      subrequests: num(r.sum?.subrequests),
      cpu_p50: num(r.quantiles?.cpuTimeP50) / 1000,
      cpu_p99: num(r.quantiles?.cpuTimeP99) / 1000,
    }))
    .sort((a, b) => b.requests - a.requests);

export function storageFigures(account: Row) {
  const days = account.r2 as Row[];
  const first = num(days[0]?.max?.payloadSize);
  const last = num(days.at(-1)?.max?.payloadSize);
  return { bytes: last, change_7d: last - first, objects: num(days.at(-1)?.max?.objectCount) };
}

export const databaseFigures = (account: Row) => ({
  latency_p50: num(account.latency?.[0]?.quantiles?.queryBatchTimeMsP50),
  latency_p90: num(account.latency?.[0]?.quantiles?.queryBatchTimeMsP90),
  bytes: num(account.size?.[0]?.max?.databaseSizeBytes),
});

let held: { at: number; key: string; report: Infrastructure } | null = null;
export const forgetInfra = () => {
  held = null;
};

/** `GET infrastructure`. */
export async function infraReport(
  env: Env,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<InfrastructureResult> {
  if (!opsOn(env)) return { ok: false, reason: 'off' };
  const account = env.CF_ACCOUNT_ID ?? '';
  const token = env.ANALYTICS_READ_TOKEN ?? '';
  const ids = resources(env);
  if (!ACCOUNT.test(account) || !token || !ids) return { ok: false, reason: 'not_configured' };
  const key = `${account}:${env.OPS_RESOURCES}`;
  if (held && held.key === key && now - held.at < HELD_MS) return { ok: true, report: held.report };
  const end = new Date(now - INGEST_DELAY_MS);
  const start = new Date(end.getTime() - WINDOW_MS);
  const window = { start: start.toISOString(), end: end.toISOString() };
  const ask = async <T>(
    name: string,
    query: string,
    variables: object,
    read: (row: Row) => T,
  ): Promise<Section<T>> => {
    try {
      const response = await fetcher(GRAPHQL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables: { account, ...variables } }),
      });
      if (!response.ok) throw new Error(`GraphQL API answered ${response.status}`);
      const answer = (await response.json()) as { data?: Row; errors?: unknown[] | null };
      // A refused query answers 200 with `errors`.
      if (answer.errors?.length) throw new Error('GraphQL API answered with errors');
      const found = answer.data?.viewer?.accounts?.[0];
      if (!found) throw new Error('GraphQL API answered without the account');
      return { ok: true, value: read(found) };
    } catch (e) {
      log.error('infra_report.failed', { kind: name, error: e });
      return { ok: false };
    }
  };
  const [queues, workers, database, storage] = await Promise.all([
    ask('queues', QUEUES, { ...window, queues: Object.values(ids.queues) }, (r) =>
      queueRows(r, ids.queues),
    ),
    ask('workers', WORKERS, { ...window, scripts: ids.scripts }, workerRows),
    ask('database', DATABASE, { d1: ids.d1, day: window.end.slice(0, 10) }, databaseFigures),
    ask(
      'storage',
      STORAGE,
      { r2: ids.r2, end: window.end, week: new Date(end.getTime() - WEEK_MS).toISOString() },
      storageFigures,
    ),
  ]);
  const report = { ...window, queues, workers, database, storage };
  held = { at: now, key, report };
  return { ok: true, report };
}
