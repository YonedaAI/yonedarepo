// What tail events cannot show, read from Cloudflare's GraphQL Analytics API: queue backlog,
// lag and dead-lettering per queue, Durable Object resource kills, and check container disk. One
// GraphQL request per declared authority keeps the query budget explicit. Errors carry only status codes and
// Cloudflare's error messages, never request headers.

import { resolveIds } from './analytics-resources';
import type { WatchSite, WatchTarget } from './config';
import { TelemetryError } from './telemetry-error';

export { resolveIds } from './analytics-resources';
export { TelemetryError } from './telemetry-error';

import { DELIVERY_QUERY, type QueueMinutes, queueMinutes } from './delivery';

export const API_URL = 'https://api.cloudflare.com/client/v4';
export const GRAPHQL_URL = `${API_URL}/graphql`;
/** Analytics arrive a few minutes late; the window ends this long before now. */
const INGEST_DELAY_MS = 5 * 60_000;
export const WINDOW_MS = 60 * 60_000;

export interface QueueStats {
  backlogLatest: number;
  backlogEarliest: number;
  lagMs: number | null;
  retries: number | null;
  deadLettered: number;
}
export interface AuthorityAnalytics {
  /** Platform-side CPU, memory and fatal kills per Durable Object class. */
  objectKills: Record<keyof WatchTarget['namespaces'], number>;
  /** The platform's jobs queue, and the dead letter queue it shares with checks. */
  queue: QueueStats & { deadLetterBacklog: number };
  /** On the wide watch. */
  checks: QueueStats | null;
  containers: { maxDiskPercent: number | null };
}
export interface Analytics extends AuthorityAnalytics {
  window: { start: string; end: string };
  managed: (QueueStats & { deadLetterBacklog: number }) | null;
  regional?: Record<string, AuthorityAnalytics>;
}
export interface AnalyticsSource {
  collect(now: number): Promise<Analytics>;
  /** The jobs queue by the minute over a window; a source that can't has no such method. */
  delivery?(start: string, end: string): Promise<QueueMinutes>;
}

const QUERY = `query Superfan($account: string!, $start: Time!, $end: Time!,
  $namespaces: [string!], $queues: [string!], $app: string!) {
  viewer { accounts(filter: { accountTag: $account }) {
    objectPeriodic: durableObjectsPeriodicGroups(limit: 50, filter: { namespaceId_in: $namespaces, datetime_geq: $start, datetime_leq: $end }) {
      sum { exceededCpuErrors exceededMemoryErrors fatalInternalErrors } dimensions { namespaceId } }
    backlog: queueBacklogAdaptiveGroups(limit: 200, orderBy: [datetimeFiveMinutes_ASC], filter: { queueId_in: $queues, datetime_geq: $start, datetime_leq: $end }) {
      avg { messages } dimensions { queueId datetimeFiveMinutes } }
    queueOps: queueMessageOperationsAdaptiveGroups(limit: 200, filter: { queueId_in: $queues, datetime_geq: $start, datetime_leq: $end }) {
      sum { billableOperations } avg { lagTime retryCount } dimensions { queueId actionType outcome } }
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
  const waiting = (queue: string) => num(backlog(queue).at(-1)?.avg?.messages);
  const stats = (queue: string): QueueStats => {
    const ops = (account.queueOps as Row[]).filter((r) => r.dimensions?.queueId === queue);
    const reads = ops.filter((r) => r.dimensions?.actionType !== 'WriteMessage');
    const maxOf = (key: string) =>
      reads.length ? Math.max(...reads.map((r) => num(r.avg?.[key]))) : null;
    return {
      backlogLatest: waiting(queue),
      backlogEarliest: num(backlog(queue)[0]?.avg?.messages),
      lagMs: maxOf('lagTime'),
      retries: maxOf('retryCount'),
      deadLettered: ops
        .filter((r) => r.dimensions?.outcome === 'dlq')
        .reduce((total, r) => total + num(r.sum?.billableOperations), 0),
    };
  };
  const { queues } = target;
  const disk = account.containers?.[0]?.max?.diskUsagePercentage;
  return {
    window,
    objectKills: {
      source_repository: kills(target.namespaces.source_repository),
      check_runs: kills(target.namespaces.check_runs),
    },
    queue: { ...stats(queues.jobs), deadLetterBacklog: waiting(queues.deadLetter) },
    checks: queues.checks ? stats(queues.checks) : null,
    managed:
      queues.managedRuns && queues.managedDeadLetter
        ? { ...stats(queues.managedRuns), deadLetterBacklog: waiting(queues.managedDeadLetter) }
        : null,
    containers: { maxDiskPercent: typeof disk === 'number' ? disk : null },
  };
}

export class CloudflareAnalytics implements AnalyticsSource {
  private resolved: WatchTarget | null = null;
  private resolving: Promise<WatchTarget> | null = null;
  constructor(
    private readonly site: WatchSite,
    private readonly token: string,
  ) {}

  /** The configured ids, else the ones looked up by name (once per instance, so per run). */
  target(): Promise<WatchTarget> {
    if (this.resolved) return Promise.resolve(this.resolved);
    // One source instance belongs to one watch pass: collect/delivery may overlap.
    this.resolving ??= this.loadTarget().finally(() => {
      this.resolving = null;
    });
    return this.resolving;
  }

  private async loadTarget(): Promise<WatchTarget> {
    const { ids, ...site } = this.site;
    this.resolved = {
      ...site,
      ...(ids && !site.backendScripts?.includes(`${site.script}-weur`)
        ? ids
        : await resolveIds(this.site, this.token)),
    };
    return this.resolved;
  }

  async collect(now: number): Promise<Analytics> {
    const end = new Date(now - INGEST_DELAY_MS);
    const window = {
      start: new Date(end.getTime() - WINDOW_MS).toISOString(),
      end: end.toISOString(),
    };
    const t = await this.target();
    const read = async (target: WatchTarget) =>
      parseAccount(
        await this.ask(QUERY, {
          account: target.account,
          ...window,
          namespaces: Object.values(target.namespaces),
          queues: Object.values(target.queues),
          app: target.checkApp,
        }),
        target,
        window,
      );
    const regions = Object.entries(t.regional ?? {});
    const [primary, ...regional] = await Promise.all([
      read(t),
      ...regions.map(([, ids]) => read({ ...t, ...ids })),
    ]);
    return {
      ...primary,
      ...(regions.length && {
        regional: Object.fromEntries(regions.map(([region], i) => [region, regional[i]])),
      }),
    };
  }

  async delivery(start: string, end: string) {
    const { account, queues } = await this.target();
    const variables = { account, start, end, queues: [queues.jobs] };
    return queueMinutes(await this.ask(DELIVERY_QUERY, variables));
  }

  /** One GraphQL request's account result; a failure is a telemetry error. */
  private async ask(query: string, variables: object): Promise<Row> {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
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
    return account;
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
