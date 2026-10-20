// Deterministic signals per platform component. A model is consulted only when one of these
// rules fires, so a quiet platform costs nothing. Latency rules compare against a stored
// baseline (an EWMA fed only by quiet runs, so an incident cannot become the new normal).
import type { ObjectClass, Snapshot } from './telemetry';

export type Component =
  | 'api_worker'
  | 'source_repository'
  | 'object_push_queue'
  | 'land_queue'
  | 'check_runs'
  | 'derived_jobs';

export interface Signal {
  name: string;
  value: number | null;
  unit: string;
  anomalous: boolean;
  rule: string;
  baseline?: number;
  /** Set on latency signals with enough traffic to feed the baseline. */
  sample?: number;
}
export interface ComponentReport {
  component: Component;
  /** False when no readable telemetry exists for this component yet. */
  watched: boolean;
  signals: Signal[];
  anomalous: boolean;
}
export type Baselines = Record<string, { value: number; samples: number }>;

const MIN_REQUESTS = 20;
const MAX_ERROR_RATE = 0.02;
const DRIFT_FACTOR = 2;
/** A p95 rise smaller than this is noise even when it doubles. */
const DRIFT_FLOOR_MS = 100;
const MIN_BASELINE_SAMPLES = 3;
const MAX_EXCEPTIONS = 3;
const MAX_BACKLOG = 50;
const MAX_LAG_MS = 120_000;
const MAX_RETRIES = 1;
const MAX_DISK_PERCENT = 85;
const EXCEPTION_STATUSES = ['scriptThrewException', 'exceededResources', 'internalError'];

export const baselineKey = (component: Component, signal: string) => `${component}/${signal}`;

function errorRate(requests: number, errors: number): Signal {
  const value = requests ? errors / requests : 0;
  return {
    name: 'error_rate',
    value: Number(value.toFixed(4)),
    unit: 'ratio',
    anomalous: requests >= MIN_REQUESTS && value > MAX_ERROR_RATE,
    rule: `> ${MAX_ERROR_RATE} with >= ${MIN_REQUESTS} requests`,
  };
}

function exceptions(byStatus: Record<string, number>): Signal {
  const value = EXCEPTION_STATUSES.reduce((total, status) => total + (byStatus[status] ?? 0), 0);
  return {
    name: 'exceptions',
    value,
    unit: 'count',
    anomalous: value >= MAX_EXCEPTIONS,
    rule: `>= ${MAX_EXCEPTIONS} thrown or resource-killed invocations`,
  };
}

function drift(
  component: Component,
  name: string,
  value: number | null,
  requests: number,
  baselines: Baselines,
): Signal {
  const base = baselines[baselineKey(component, name)];
  const ready = base && base.samples >= MIN_BASELINE_SAMPLES;
  return {
    name,
    value,
    unit: 'ms',
    anomalous: Boolean(
      ready &&
        value !== null &&
        requests >= MIN_REQUESTS &&
        value > base.value * DRIFT_FACTOR &&
        value - base.value >= DRIFT_FLOOR_MS,
    ),
    rule: `> ${DRIFT_FACTOR}x baseline (+${DRIFT_FLOOR_MS} ms) after ${MIN_BASELINE_SAMPLES} quiet runs`,
    ...(base ? { baseline: Math.round(base.value) } : {}),
    ...(value !== null && requests >= MIN_REQUESTS ? { sample: value } : {}),
  };
}

function threshold(name: string, value: number | null, unit: string, max: number): Signal {
  return { name, value, unit, anomalous: value !== null && value > max, rule: `> ${max}` };
}

function objectSignals(component: Component, o: ObjectClass, baselines: Baselines): Signal[] {
  return [
    errorRate(o.requests, o.errors),
    exceptions(o.byStatus),
    drift(component, 'p95_wall_ms', o.p95WallMs, o.requests, baselines),
    threshold('resource_kills', o.exceededCpu + o.exceededMemory + o.fatal, 'count', 0),
  ];
}

function report(component: Component, signals: Signal[], watched = true): ComponentReport {
  return { component, watched, signals, anomalous: signals.some((s) => s.anomalous) };
}

/** Evaluates every component's rules against one snapshot. */
export function evaluate(s: Snapshot, baselines: Baselines): ComponentReport[] {
  const q = s.queue;
  const growing = q.backlogLatest > 10 && q.backlogLatest > 2 * Math.max(q.backlogEarliest, 1);
  return [
    report('api_worker', [
      errorRate(s.worker.requests, s.worker.errors),
      exceptions(s.worker.byStatus),
      drift('api_worker', 'p95_wall_ms', s.worker.p95WallMs, s.worker.requests, baselines),
      {
        name: 'health',
        value: s.health.status,
        unit: 'http_status',
        anomalous: !s.health.ok,
        rule: '/health must answer 200 as yonedarepo-platform',
      },
    ]),
    // Commit and land both run inside the repository authority.
    report(
      'source_repository',
      objectSignals('source_repository', s.objects.source_repository, baselines),
    ),
    // Push waits grow when Artifacts answers receive-pack busy and the queue retries.
    report(
      'object_push_queue',
      objectSignals('object_push_queue', s.objects.object_push_queue, baselines),
    ),
    // The per-branch land queue is SQL state inside SourceRepository; no external counter yet.
    report('land_queue', [], false),
    report('check_runs', [
      ...objectSignals('check_runs', s.objects.check_runs, baselines),
      threshold('container_disk_percent', s.containers.maxDiskPercent, 'percent', MAX_DISK_PERCENT),
    ]),
    report('derived_jobs', [
      threshold('backlog', q.backlogLatest, 'messages', MAX_BACKLOG),
      {
        name: 'backlog_growth',
        value: q.backlogLatest - q.backlogEarliest,
        unit: 'messages',
        anomalous: growing,
        rule: 'latest > 2x window start and > 10',
      },
      threshold('dead_letter_backlog', q.deadLetterBacklog, 'messages', 0),
      threshold('dead_lettered', q.deadLettered, 'messages', 0),
      threshold('lag_ms', q.lagMs, 'ms', MAX_LAG_MS),
      threshold('retries_per_message', q.retries, 'avg', MAX_RETRIES),
    ]),
  ];
}

/** Baseline updates from this run: only drift signals of components that were quiet. */
export function baselineSamples(reports: ComponentReport[]) {
  const samples: { key: string; value: number }[] = [];
  for (const r of reports)
    if (!r.anomalous)
      for (const s of r.signals)
        if (s.sample !== undefined)
          samples.push({ key: baselineKey(r.component, s.name), value: s.sample });
  return samples;
}

/** Stable identity of a problem: the component plus the set of rules that fired. */
export function dedupKey(r: ComponentReport) {
  const fired = r.signals.filter((s) => s.anomalous).map((s) => s.name);
  return `${r.component}:${fired.sort().join('+')}`;
}

/** A one-line summary built from numbers alone, stored even when no model is consulted. */
export function summary(r: ComponentReport) {
  return r.signals
    .filter((s) => s.anomalous)
    .map(
      (s) =>
        `${s.name}=${s.value}${s.unit === 'ms' ? 'ms' : ''} (${s.rule}${s.baseline !== undefined ? `; baseline ${s.baseline}ms` : ''})`,
    )
    .join('; ');
}
