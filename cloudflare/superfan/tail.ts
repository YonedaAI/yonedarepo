// Turns the watched Worker's tail events (one per invocation: outcome, logs, exceptions,
// CPU and wall time) into per-minute, per-component counters. No API token is involved:
// Cloudflare delivers these because the platform Worker lists the superfan as a tail
// consumer. Exception text is untrusted; it is redacted and truncated before storage.

export type TailComponent =
  | 'api_worker'
  | 'source_repository'
  | 'object_push_queue'
  | 'check_runs'
  | 'derived_jobs';
export interface TailSample {
  name: string;
  message: string;
}
export interface TailCounts {
  invocations: number;
  errors: number;
  exceptions: number;
  resourceKills: number;
  errorLogs: number;
  pushRetries: number;
}
export interface TailRow extends TailCounts {
  minute: number;
  component: TailComponent;
  hist: number[];
  samples: TailSample[];
}
export interface TailStats extends TailCounts {
  p95WallMs: number | null;
  samples: TailSample[];
}

/** Durable Object classes of the platform Worker, by tail `entrypoint`. */
const OBJECT_CLASSES: Record<string, TailComponent> = {
  SourceRepository: 'source_repository',
  ObjectPushQueue: 'object_push_queue',
  CheckContainer: 'check_runs',
};
const RESOURCE_KILLS = new Set(['exceededCpu', 'exceededMemory']);
/** Logged by pushCommit (repo-object-push.ts) when Artifacts refuses a push and it retries. */
const PUSH_RETRY = /^object store push attempt \d+/;
/** Wall-time histogram: bucket i holds times up to 5 ms x 1.5^i (the last is unbounded). */
const BUCKETS = 28;
const MAX_SAMPLES = 3;

export const emptyHist = () => new Array<number>(BUCKETS).fill(0);
const bucketLimit = (i: number) => 5 * 1.5 ** i;
function bucket(ms: number) {
  for (let i = 0; i < BUCKETS - 1; i++) if (ms <= bucketLimit(i)) return i;
  return BUCKETS - 1;
}

/** Upper bound of the bucket holding the 95th percentile; null without data. */
export function p95(hist: number[]): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= total * 0.95) return Math.round(bucketLimit(Math.min(i, BUCKETS - 2)));
  }
  return null;
}

export const mergeHist = (a: number[], b: number[]) =>
  emptyHist().map((_, i) => (a[i] ?? 0) + (b[i] ?? 0));

/** Strips anything shaped like a credential, then bounds the length. */
export function redact(text: string) {
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(yrp_|yoneda\.|tp-|ttp-|sk-)[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
    .slice(0, 200);
}

const text = (message: unknown) =>
  Array.isArray(message) ? message.map((m) => String(m)).join(' ') : String(message);

function classify(item: TraceItem): TailComponent | null {
  if (item.executionModel === 'durableObject') return OBJECT_CLASSES[item.entrypoint ?? ''] ?? null;
  const event = item.event as Record<string, unknown> | null;
  if (event && 'queue' in event) return 'derived_jobs';
  if (event && 'request' in event) return 'api_worker';
  return null;
}

/** Aggregates one tail batch; events from any other script are ignored. */
export function aggregate(events: TraceItem[], script: string): TailRow[] {
  const rows = new Map<string, TailRow>();
  const row = (minute: number, component: TailComponent) => {
    const key = `${minute}/${component}`;
    let r = rows.get(key);
    if (!r) {
      r = {
        minute,
        component,
        invocations: 0,
        errors: 0,
        exceptions: 0,
        resourceKills: 0,
        errorLogs: 0,
        pushRetries: 0,
        hist: emptyHist(),
        samples: [],
      };
      rows.set(key, r);
    }
    return r;
  };
  for (const item of events) {
    if (item.scriptName !== script) continue;
    const minute = Math.floor((item.eventTimestamp ?? Date.now()) / 60_000) * 60_000;
    const retries = item.logs.filter((l) => PUSH_RETRY.test(text(l.message))).length;
    if (retries) row(minute, 'object_push_queue').pushRetries += retries;
    const component = classify(item);
    if (!component) continue;
    const r = row(minute, component);
    const status = (item.event as { response?: { status?: number } } | null)?.response?.status;
    const thrown = item.outcome === 'exception' || item.exceptions.length > 0;
    const killed = RESOURCE_KILLS.has(item.outcome);
    r.invocations++;
    if (thrown) r.exceptions++;
    if (killed) r.resourceKills++;
    if (thrown || killed || (status ?? 0) >= 500) r.errors++;
    r.errorLogs += item.logs.filter((l) => l.level === 'error').length;
    r.hist[bucket(item.wallTime)]++;
    for (const e of item.exceptions)
      if (r.samples.length < MAX_SAMPLES)
        r.samples.push({ name: redact(e.name), message: redact(e.message) });
  }
  return [...rows.values()];
}
