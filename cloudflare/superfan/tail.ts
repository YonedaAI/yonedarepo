// Turns the watched Workers' tail events (one per invocation: outcome, logs, exceptions,
// CPU and wall time) into per-minute, per-component counters, and counts the few log events
// that mean something alone. No API token is involved: Cloudflare delivers these because each
// watched Worker lists the superfan as a tail consumer. Exception text is untrusted; it is
// redacted and truncated before storage.

export type TailComponent =
  | 'api_worker'
  | 'source_repository'
  | 'object_push_queue'
  | 'check_runs'
  | 'derived_jobs'
  | 'land_queue'
  | 'commit_shards'
  | 'pack_builder'
  | 'ssh_gateway'
  | 'workspace_authority'
  | 'cron'
  | 'front_worker'
  | 'managed_worker';
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
  /** Named log events counted this minute (`markOf`). */
  marks: Record<string, number>;
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
  LandCombiner: 'land_queue',
  CommitShard: 'commit_shards',
  PackBuilder: 'pack_builder',
  SshGateway: 'ssh_gateway',
  WorkspaceAuthority: 'workspace_authority',
};
const RESOURCE_KILLS = new Set(['exceededCpu', 'exceededMemory']);
/** Logged by pushCommit (repo-object-push.ts) when Artifacts refuses a push and it retries: as
 * text, or as JSON from the shared logger. Superfan deploys first, so it reads both. */
/** Every deploy restarts Durable Objects, and calls in flight then throw this: it isn't a fault. */
const DEPLOY_RESET = /Durable Object reset because its code was updated/;
const PUSH_RETRY = /^object store push attempt \d+|"event":"object\.push_retry"/;
/** Logged by compactLog (repo-compaction.ts) when a hold has stalled a repository's log. */
export const STALL_SAMPLE = 'compaction.stalled';
/**
 * Log events that mean something alone, by what they count as. Some are logged once and never
 * again (a level crossed, a night's reconcile), so they are kept apart from the samples, which a
 * burst of exceptions pushes out. Numbers only: an account or repository stays in Workers Logs,
 * but for `NAMING`.
 */
const MARKS = new Map([
  ['billing.reconcile.mismatch', 'reconcile_mismatches'],
  [STALL_SAMPLE, 'compaction_stalls'],
  ['undo.sweep_failed', 'cron_failures'],
  ['compaction.sweep_failed', 'cron_failures'],
  ['billing.reconcile_failed', 'cron_failures'],
  // What nightlyReconcile (platform-admin-billing.ts) logs when the managed Worker refuses it.
  ['billing.reconcile', 'cron_failures'],
  ['ssh.keepalive_failed', 'cron_failures'],
  ['land.batch_failed', 'land_failures'],
  ['land.submitted_batch_failed', 'land_failures'],
  ['land.step_failed', 'land_failures'],
  ['land.timed_out', 'land_timeouts'],
  // A full repository stops landing, so its size may never be sampled at the limit.
  ['repo.full', 'storage_full'],
]);
/**
 * Marks whose finding has to say which row, as nobody can search a repository's own tables from
 * the logs: their key carries the repository and event (`<mark>|<repo>|<seq>`). Only ids of that
 * exact shape get in, so nothing else a line holds can reach a finding, a mail or the model.
 */
const NAMING = new Map([
  ['audit.event_corrupt', 'audit_event_corrupt'],
  ['audit.erase_blocked', 'audit_erase_blocked'],
]);
const REPO_ID = /^r[0-9a-f]{20}$/;
export const NAMED_SEPARATOR = '|';

function namedMark(mark: string, repo: unknown, seq: unknown) {
  if (typeof repo !== 'string' || !REPO_ID.test(repo)) return mark;
  const event = Number.isSafeInteger(seq) && (seq as number) > 0 ? seq : '';
  return [mark, repo, event].join(NAMED_SEPARATOR);
}

/** Sizes `repo.storage` reports (STORAGE_LEVELS, repo-storage.ts) that tell someone: not 5 GB. */
const STORAGE_8GB = 8e9;
const STORAGE_9GB = 9e9;
/** Where new work stops (`STORAGE_GUARD_BYTES`, durable.ts). */
const STORAGE_FULL = 9.4e9;
/** Longer than any line can leave after redaction; what bounds the patterns' work. */
const REDACT_INPUT = 2_000;
/** How long a mark holds its signal: under a day, so a night's mismatch closes before the next
 * night's can open it again, and long enough to outlast a few missed passes. */
export const MARK_WINDOW_MS = 20 * 60 * 60_000;
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

/** Strips anything shaped like a credential or an email address, then bounds the length. */
export function redact(text: string) {
  return text
    .slice(0, REDACT_INPUT)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g, '[email]')
    .replace(/\b(yrp_|yoneda\.|tp-|ttp-|sk-)[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
    .slice(0, 200);
}

const text = (message: unknown) =>
  Array.isArray(message) ? message.map((m) => String(m)).join(' ') : String(message);

/** What a log line counts as, if anything. Lines are one JSON string or one object. */
function markOf(message: unknown): string | null {
  const first = Array.isArray(message) ? message[0] : message;
  let line: unknown = first;
  if (typeof first === 'string') {
    if (!first.startsWith('{')) return null;
    try {
      line = JSON.parse(first);
    } catch {
      return null;
    }
  }
  const {
    event,
    db_bytes: bytes,
    repo,
    seq,
  } = (line ?? {}) as { event?: unknown; db_bytes?: unknown; repo?: unknown; seq?: unknown };
  if (event === 'repo.storage' && typeof bytes === 'number')
    return bytes >= STORAGE_FULL
      ? 'storage_full'
      : bytes >= STORAGE_9GB
        ? 'storage_9gb'
        : bytes >= STORAGE_8GB
          ? 'storage_8gb'
          : null;
  if (typeof event !== 'string') return null;
  const naming = NAMING.get(event);
  return naming ? namedMark(naming, repo, seq) : (MARKS.get(event) ?? null);
}

function classify(item: TraceItem): TailComponent | null {
  if (item.executionModel === 'durableObject') return OBJECT_CLASSES[item.entrypoint ?? ''] ?? null;
  const event = item.event as Record<string, unknown> | null;
  if (event && 'cron' in event) return 'cron';
  if (event && 'queue' in event) return 'derived_jobs';
  if (event && 'request' in event) return 'api_worker';
  return null;
}

/** The scripts read: the platform Worker (null: classified per event), and on the wide watch its
 * environment's front and managed Workers, each one component. */
function watched(script: string, wide: boolean) {
  const prefix = script.replace(/-platform$/, '');
  return new Map<string, TailComponent | null>([
    [script, null],
    ...(wide
      ? ([
          [`${prefix}-agents`, 'front_worker'],
          [`${prefix}-agents-managed`, 'managed_worker'],
        ] as const)
      : []),
  ]);
}

/** Aggregates one tail batch; events from any other script are ignored. */
export function aggregate(events: TraceItem[], script: string, wide = false): TailRow[] {
  const scripts = watched(script, wide);
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
        marks: {},
      };
      rows.set(key, r);
    }
    return r;
  };
  for (const item of events) {
    const owner = scripts.get(item.scriptName ?? '');
    if (owner === undefined) continue;
    const minute = Math.floor((item.eventTimestamp ?? Date.now()) / 60_000) * 60_000;
    const retries = item.logs.filter((l) => PUSH_RETRY.test(text(l.message))).length;
    if (retries) row(minute, 'object_push_queue').pushRetries += retries;
    const component = owner ?? classify(item);
    const named = item.logs.map((l) => markOf(l.message)).filter((m) => m !== null);
    // A mark counts whichever invocation logged it, one this watcher has no component for too.
    if (named.length) {
      const { marks } = row(minute, component ?? 'api_worker');
      for (const mark of named) marks[mark] = (marks[mark] ?? 0) + 1;
    }
    if (!component) continue;
    const r = row(minute, component);
    const status = (item.event as { response?: { status?: number } } | null)?.response?.status;
    const real = item.exceptions.filter((e) => !DEPLOY_RESET.test(e.message));
    const thrown =
      real.length > 0 || (item.outcome === 'exception' && item.exceptions.length === 0);
    const killed = RESOURCE_KILLS.has(item.outcome);
    r.invocations++;
    if (thrown) r.exceptions++;
    if (killed) r.resourceKills++;
    if (thrown || killed || (status ?? 0) >= 500) r.errors++;
    r.errorLogs += item.logs.filter((l) => l.level === 'error').length;
    r.hist[bucket(item.wallTime)]++;
    for (const e of real)
      if (r.samples.length < MAX_SAMPLES)
        r.samples.push({ name: redact(e.name), message: redact(e.message) });
    for (const l of item.logs)
      if (r.samples.length < MAX_SAMPLES && markOf(l.message) === 'compaction_stalls')
        r.samples.push({ name: STALL_SAMPLE, message: redact(text(l.message)) });
  }
  return [...rows.values()];
}
