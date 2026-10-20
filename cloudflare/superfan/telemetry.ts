// Reads the watched Worker's telemetry from Cloudflare's GraphQL Analytics API (one request
// per run, which keeps within the API's query budget) plus its public /health probe. Errors
// carry only status codes and Cloudflare's error messages, never request headers.
import type { WatchTarget } from './config';

export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
/** Analytics arrive a few minutes late; the window ends this long before now. */
const INGEST_DELAY_MS = 5 * 60_000;
const WINDOW_MS = 60 * 60_000;

export interface Invocations {
  requests: number;
  errors: number;
  p95WallMs: number | null;
  byStatus: Record<string, number>;
}
export interface ObjectClass extends Invocations {
  exceededCpu: number;
  exceededMemory: number;
  fatal: number;
}
export interface Snapshot {
  window: { start: string; end: string };
  worker: Invocations & { p95CpuMs: number | null };
  health: { ok: boolean; status: number | null; latencyMs: number };
  objects: Record<keyof WatchTarget['namespaces'], ObjectClass>;
  queue: {
    backlogLatest: number;
    backlogEarliest: number;
    deadLetterBacklog: number;
    lagMs: number | null;
    retries: number | null;
    deadLettered: number;
  };
  containers: { maxDiskPercent: number | null };
}
export interface TelemetrySource {
  collect(now: number): Promise<Snapshot>;
}

/** Telemetry could not be read; `reason` is safe to store and show. */
export class TelemetryError extends Error {
  constructor(
    readonly reason: 'disabled' | 'token_missing' | 'fetch_failed',
    detail: string,
  ) {
    super(detail);
  }
}

const QUERY = `query Superfan($account: string!, $script: string!, $start: Time!, $end: Time!,
  $namespaces: [string!], $queues: [string!], $jobs: string!, $app: string!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workerAll: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }) {
      sum { requests errors } quantiles { wallTimeP95 cpuTimeP95 } }
    workerStatus: workersInvocationsAdaptive(limit: 50, filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }) {
      sum { requests } dimensions { status } }
    objectAll: durableObjectsInvocationsAdaptiveGroups(limit: 50, filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }) {
      sum { requests errors } quantiles { wallTimeP95 } dimensions { namespaceId } }
    objectStatus: durableObjectsInvocationsAdaptiveGroups(limit: 200, filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }) {
      sum { requests } dimensions { namespaceId status } }
    objectPeriodic: durableObjectsPeriodicGroups(limit: 50, filter: { namespaceId_in: $namespaces, datetime_geq: $start, datetime_leq: $end }) {
      sum { exceededCpuErrors exceededMemoryErrors fatalInternalErrors } dimensions { namespaceId } }
    backlog: queueBacklogAdaptiveGroups(limit: 200, orderBy: [datetimeFiveMinutes_ASC], filter: { queueId_in: $queues, datetime_geq: $start, datetime_leq: $end }) {
      avg { messages } dimensions { queueId datetimeFiveMinutes } }
    queueOps: queueMessageOperationsAdaptiveGroups(limit: 50, filter: { queueId: $jobs, datetime_geq: $start, datetime_leq: $end }) {
      sum { billableOperations } avg { lagTime retryCount } dimensions { actionType outcome } }
    containers: containersMetricsAdaptiveGroups(limit: 1, filter: { applicationId: $app, datetime_geq: $start, datetime_leq: $end }) {
      max { diskUsagePercentage } }
  } }
}`;

type Row = Record<string, any>;
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const ms = (micros: unknown) => (typeof micros === 'number' ? Math.round(micros / 1000) : null);

function objectClass(account: Row, namespace: string): ObjectClass {
  const all = (account.objectAll as Row[]).find((r) => r.dimensions?.namespaceId === namespace);
  const periodic = (account.objectPeriodic as Row[]).find(
    (r) => r.dimensions?.namespaceId === namespace,
  );
  const byStatus: Record<string, number> = {};
  for (const row of account.objectStatus as Row[])
    if (row.dimensions?.namespaceId === namespace)
      byStatus[row.dimensions.status] = num(row.sum?.requests);
  return {
    requests: num(all?.sum?.requests),
    errors: num(all?.sum?.errors),
    p95WallMs: ms(all?.quantiles?.wallTimeP95),
    byStatus,
    exceededCpu: num(periodic?.sum?.exceededCpuErrors),
    exceededMemory: num(periodic?.sum?.exceededMemoryErrors),
    fatal: num(periodic?.sum?.fatalInternalErrors),
  };
}

/** Shapes one GraphQL account result into a snapshot; missing groups read as zero traffic. */
export function parseAccount(
  account: Row,
  target: WatchTarget,
  window: Snapshot['window'],
  health: Snapshot['health'],
): Snapshot {
  const worker = (account.workerAll as Row[])[0];
  const byStatus: Record<string, number> = {};
  for (const row of account.workerStatus as Row[])
    byStatus[row.dimensions?.status] = num(row.sum?.requests);
  const jobs = (account.backlog as Row[]).filter(
    (r) => r.dimensions?.queueId === target.queues.jobs,
  );
  const dead = (account.backlog as Row[]).filter(
    (r) => r.dimensions?.queueId === target.queues.deadLetter,
  );
  const ops = account.queueOps as Row[];
  const reads = ops.filter((r) => r.dimensions?.actionType !== 'WriteMessage');
  const maxOf = (rows: Row[], key: string) =>
    rows.length ? Math.max(...rows.map((r) => num(r.avg?.[key]))) : null;
  return {
    window,
    worker: {
      requests: num(worker?.sum?.requests),
      errors: num(worker?.sum?.errors),
      p95WallMs: ms(worker?.quantiles?.wallTimeP95),
      p95CpuMs: ms(worker?.quantiles?.cpuTimeP95),
      byStatus,
    },
    health,
    objects: {
      source_repository: objectClass(account, target.namespaces.source_repository),
      object_push_queue: objectClass(account, target.namespaces.object_push_queue),
      check_runs: objectClass(account, target.namespaces.check_runs),
    },
    queue: {
      backlogLatest: num(jobs.at(-1)?.avg?.messages),
      backlogEarliest: num(jobs[0]?.avg?.messages),
      deadLetterBacklog: num(dead.at(-1)?.avg?.messages),
      lagMs: maxOf(reads, 'lagTime'),
      retries: maxOf(reads, 'retryCount'),
      deadLettered: ops
        .filter((r) => r.dimensions?.outcome === 'dlq')
        .reduce((total, r) => total + num(r.sum?.billableOperations), 0),
    },
    containers: {
      maxDiskPercent:
        typeof account.containers?.[0]?.max?.diskUsagePercentage === 'number'
          ? account.containers[0].max.diskUsagePercentage
          : null,
    },
  };
}

async function probe(url: string): Promise<Snapshot['health']> {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const body = res.ok ? ((await res.json().catch(() => null)) as Row | null) : null;
    return {
      ok: res.ok && body?.service === 'yonedarepo-platform',
      status: res.status,
      latencyMs: Date.now() - started,
    };
  } catch {
    return { ok: false, status: null, latencyMs: Date.now() - started };
  }
}

export class CloudflareTelemetry implements TelemetrySource {
  constructor(
    private readonly target: WatchTarget,
    private readonly token: string,
  ) {}

  async collect(now: number): Promise<Snapshot> {
    const end = new Date(now - INGEST_DELAY_MS);
    const window = {
      start: new Date(end.getTime() - WINDOW_MS).toISOString(),
      end: end.toISOString(),
    };
    const t = this.target;
    const variables = {
      account: t.account,
      script: t.script,
      ...window,
      namespaces: Object.values(t.namespaces),
      queues: [t.queues.jobs, t.queues.deadLetter],
      jobs: t.queues.jobs,
      app: t.checkApp,
    };
    const [res, health] = await Promise.all([
      fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables }),
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null),
      probe(t.healthUrl),
    ]);
    if (!res) throw new TelemetryError('fetch_failed', 'GraphQL request did not complete');
    if (!res.ok) throw new TelemetryError('fetch_failed', `GraphQL HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as Row | null;
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    const account = body?.data?.viewer?.accounts?.[0];
    if (errors.length || !account) {
      const message = errors.map((e: Row) => String(e?.message ?? '')).join('; ');
      throw new TelemetryError(
        'fetch_failed',
        `GraphQL error: ${message || 'no account data'}`.slice(0, 300),
      );
    }
    return parseAccount(account, t, window, health);
  }
}
