// What tail events cannot show, read from Cloudflare's GraphQL Analytics API: queue backlog,
// lag and dead-lettering, Durable Object resource kills, and check container disk. One
// request per run keeps within the API's query budget. Errors carry only status codes and
// Cloudflare's error messages, never request headers.
import type { WatchIds, WatchSite, WatchTarget } from './config';

export const API_URL = 'https://api.cloudflare.com/client/v4';
export const GRAPHQL_URL = `${API_URL}/graphql`;
/** Analytics arrive a few minutes late; the window ends this long before now. */
const INGEST_DELAY_MS = 5 * 60_000;
export const WINDOW_MS = 60 * 60_000;

export interface Analytics {
  window: { start: string; end: string };
  /** Platform-side CPU, memory and fatal kills per Durable Object class. */
  objectKills: Record<keyof WatchTarget['namespaces'], number>;
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
export interface AnalyticsSource {
  collect(now: number): Promise<Analytics>;
}

/** A telemetry source could not be read; `reason` is safe to store and show. */
export class TelemetryError extends Error {
  constructor(
    readonly reason: 'config' | 'disabled' | 'token_missing' | 'fetch_failed' | 'tail_silent',
    detail: string,
  ) {
    super(detail);
  }
}

const QUERY = `query Superfan($account: string!, $start: Time!, $end: Time!,
  $namespaces: [string!], $queues: [string!], $jobs: string!, $app: string!) {
  viewer { accounts(filter: { accountTag: $account }) {
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

/** Shapes one GraphQL account result; missing groups read as zero activity. */
export function parseAccount(
  account: Row,
  target: WatchTarget,
  window: Analytics['window'],
): Analytics {
  const kills = (namespace: string) => {
    const s = (account.objectPeriodic as Row[]).find(
      (r) => r.dimensions?.namespaceId === namespace,
    )?.sum;
    return num(s?.exceededCpuErrors) + num(s?.exceededMemoryErrors) + num(s?.fatalInternalErrors);
  };
  const backlog = (queue: string) =>
    (account.backlog as Row[]).filter((r) => r.dimensions?.queueId === queue);
  const jobs = backlog(target.queues.jobs);
  const ops = account.queueOps as Row[];
  const reads = ops.filter((r) => r.dimensions?.actionType !== 'WriteMessage');
  const maxOf = (key: string) =>
    reads.length ? Math.max(...reads.map((r) => num(r.avg?.[key]))) : null;
  const disk = account.containers?.[0]?.max?.diskUsagePercentage;
  return {
    window,
    objectKills: {
      source_repository: kills(target.namespaces.source_repository),
      object_push_queue: kills(target.namespaces.object_push_queue),
      check_runs: kills(target.namespaces.check_runs),
    },
    queue: {
      backlogLatest: num(jobs.at(-1)?.avg?.messages),
      backlogEarliest: num(jobs[0]?.avg?.messages),
      deadLetterBacklog: num(backlog(target.queues.deadLetter).at(-1)?.avg?.messages),
      lagMs: maxOf('lagTime'),
      retries: maxOf('retryCount'),
      deadLettered: ops
        .filter((r) => r.dimensions?.outcome === 'dlq')
        .reduce((total, r) => total + num(r.sum?.billableOperations), 0),
    },
    containers: { maxDiskPercent: typeof disk === 'number' ? disk : null },
  };
}

/**
 * The watched Worker's ids by name: its Durable Object namespaces by class (script settings),
 * its `<script>-jobs` and `<script>-dead-letter` queues and its `<script>-checkcontainer`
 * application. Three read-only REST calls; a failure is a configuration finding.
 */
export async function resolveIds(site: WatchSite, token: string): Promise<WatchIds> {
  const account = `/accounts/${site.account}`;
  const get = async (path: string): Promise<Row[] | Row> => {
    const res = await fetch(`${API_URL}${account}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as Row | null;
    if (!res?.ok || body?.success !== true)
      throw new TelemetryError(
        'config',
        `Cannot look up watch ids: GET ${path.split('?')[0]} HTTP ${res?.status ?? 'none'} (the analytics token also needs Workers Scripts Read, Queues Read and Containers Read)`,
      );
    return body.result;
  };
  const [settings, queues, apps] = await Promise.all([
    get(`/workers/scripts/${site.script}/settings`) as Promise<Row>,
    get('/queues?per_page=100') as Promise<Row[]>,
    get('/containers/applications') as Promise<Row[]>,
  ]);
  const namespace = (cls: string) =>
    (settings?.bindings as Row[] | undefined)?.find(
      (b) => b.type === 'durable_object_namespace' && b.class_name === cls && !b.script_name,
    )?.namespace_id;
  const queue = (name: string) => queues?.find?.((q) => q.queue_name === name)?.queue_id;
  const found = {
    SourceRepository: namespace('SourceRepository'),
    ObjectPushQueue: namespace('ObjectPushQueue'),
    CheckContainer: namespace('CheckContainer'),
    [`${site.script}-jobs`]: queue(`${site.script}-jobs`),
    [`${site.script}-dead-letter`]: queue(`${site.script}-dead-letter`),
    [`${site.script}-checkcontainer`]: apps?.find?.(
      (a) => a.name === `${site.script}-checkcontainer`,
    )?.id,
  };
  const missing = Object.entries(found).filter(([, value]) => typeof value !== 'string');
  if (missing.length)
    throw new TelemetryError(
      'config',
      `Cannot look up watch ids: ${missing.map(([name]) => name).join(', ')} not found`,
    );
  const v = Object.values(found) as string[];
  return {
    namespaces: { source_repository: v[0], object_push_queue: v[1], check_runs: v[2] },
    queues: { jobs: v[3], deadLetter: v[4] },
    checkApp: v[5],
  };
}

export class CloudflareAnalytics implements AnalyticsSource {
  private resolved: WatchTarget | null = null;
  constructor(
    private readonly site: WatchSite,
    private readonly token: string,
  ) {}

  /** The configured ids, else the ones looked up by name (once per instance, so per run). */
  async target(): Promise<WatchTarget> {
    if (!this.resolved) {
      const { ids, ...site } = this.site;
      this.resolved = { ...site, ...(ids ?? (await resolveIds(this.site, this.token))) };
    }
    return this.resolved;
  }

  async collect(now: number): Promise<Analytics> {
    const end = new Date(now - INGEST_DELAY_MS);
    const window = {
      start: new Date(end.getTime() - WINDOW_MS).toISOString(),
      end: end.toISOString(),
    };
    const t = await this.target();
    const variables = {
      account: t.account,
      ...window,
      namespaces: Object.values(t.namespaces),
      queues: [t.queues.jobs, t.queues.deadLetter],
      jobs: t.queues.jobs,
      app: t.checkApp,
    };
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables }),
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!res) throw new TelemetryError('fetch_failed', 'GraphQL request did not complete');
    const body = (await res.json().catch(() => null)) as Row | null;
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    const account = body?.data?.viewer?.accounts?.[0];
    if (!res.ok || errors.length || !account) {
      // Cloudflare's error messages name the problem (auth, budget, schema), never the token.
      const message = errors.map((e: Row) => String(e?.message ?? '')).join('; ');
      const status = res.ok ? 'GraphQL error' : `GraphQL HTTP ${res.status}`;
      const diagnosis = /authenticat/i.test(message) ? ` (${await this.diagnose()})` : '';
      throw new TelemetryError(
        'fetch_failed',
        `${status}${message ? `: ${message}` : ''}${diagnosis}`.slice(0, 300),
      );
    }
    return parseAccount(account, t, window);
  }

  /**
   * Why a token failed authentication, in terms safe to store: whether Cloudflare knows it
   * as a user or an account token, and its shape. Never any of its characters.
   */
  async diagnose() {
    const verify = async (path: string) => {
      const res = await fetch(`${API_URL}${path}/tokens/verify`, {
        headers: { authorization: `Bearer ${this.token}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as Row | null;
      return body?.result?.status ?? `HTTP ${res?.status ?? 'none'}`;
    };
    const [user, account] = await Promise.all([
      verify('/user'),
      verify(`/accounts/${this.site.account}`),
    ]);
    // Named markers only, so a pasted command or header is recognisable without its value.
    const markers = Object.entries({
      whitespace: /\s/,
      quotes: /["']/,
      'Bearer prefix': /Bearer/i,
      'a URL': /https?:/i,
      'a curl command': /curl/i,
    })
      .filter(([, pattern]) => pattern.test(this.token))
      .map(([name]) => name);
    const pieces = this.token.split(/\s+/).map((piece) => piece.length);
    const shape = markers.length
      ? `contains ${markers.join(', ')}; piece lengths ${pieces.join('/')}`
      : 'plain';
    return `user token: ${user}; account token: ${account}; length ${this.token.length}, ${shape}`;
  }
}

export interface Health {
  ok: boolean;
  status: number | null;
  latencyMs: number;
}

/** The platform's public health endpoint; also keeps one tail event flowing per run. */
export async function probe(url: string): Promise<Health> {
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
