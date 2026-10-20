// Deterministic signals per platform component. A model is consulted only when one of these
// rules fires, so a quiet platform costs nothing. Invocation signals come from tail events;
// queue, resource-kill and disk signals from analytics, and are omitted (not read as quiet)
// when analytics is unavailable. Latency rules compare against a stored baseline: an EWMA
// fed only by quiet runs, so an incident cannot become the new normal.
import type { Analytics, Health } from './analytics';
import type { TailComponent, TailSample, TailStats } from './tail';

export type Component = TailComponent | 'land_queue';

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
  samples: TailSample[];
}
export interface Snapshot {
  window: { start: string; end: string };
  health: Health;
  tail: Partial<Record<TailComponent, TailStats>>;
  analytics: Analytics | null;
}
export type Baselines = Record<string, { value: number; samples: number }>;

const MIN_INVOCATIONS = 20;
const MAX_ERROR_RATE = 0.02;
const DRIFT_FACTOR = 2;
/** A p95 rise smaller than this is noise even when it doubles. */
const DRIFT_FLOOR_MS = 100;
const MIN_BASELINE_SAMPLES = 3;
const MAX_EXCEPTIONS = 3;
const MAX_ERROR_LOGS = 5;
const MAX_PUSH_RETRIES = 5;
const MAX_BACKLOG = 50;
const MAX_LAG_MS = 120_000;
const MAX_RETRIES = 1;
const MAX_DISK_PERCENT = 85;

export const baselineKey = (component: Component, signal: string) => `${component}/${signal}`;

function threshold(name: string, value: number | null, unit: string, max: number): Signal {
  return { name, value, unit, anomalous: value !== null && value > max, rule: `> ${max}` };
}

function drift(component: Component, t: TailStats, baselines: Baselines): Signal {
  const base = baselines[baselineKey(component, 'p95_wall_ms')];
  const value = t.p95WallMs;
  const enough = value !== null && t.invocations >= MIN_INVOCATIONS;
  return {
    name: 'p95_wall_ms',
    value,
    unit: 'ms',
    anomalous: Boolean(
      enough &&
        base &&
        base.samples >= MIN_BASELINE_SAMPLES &&
        value > base.value * DRIFT_FACTOR &&
        value - base.value >= DRIFT_FLOOR_MS,
    ),
    rule: `> ${DRIFT_FACTOR}x baseline (+${DRIFT_FLOOR_MS} ms) after ${MIN_BASELINE_SAMPLES} quiet runs`,
    ...(base ? { baseline: Math.round(base.value) } : {}),
    ...(enough ? { sample: value } : {}),
  };
}

/** Error rate, exceptions, error logs and p95 drift from one component's tail events. */
function invocationSignals(component: Component, s: Snapshot, baselines: Baselines): Signal[] {
  const t = s.tail[component as TailComponent];
  if (!t) return [];
  const rate = t.invocations ? t.errors / t.invocations : 0;
  return [
    {
      name: 'error_rate',
      value: Number(rate.toFixed(4)),
      unit: 'ratio',
      anomalous: t.invocations >= MIN_INVOCATIONS && rate > MAX_ERROR_RATE,
      rule: `> ${MAX_ERROR_RATE} with >= ${MIN_INVOCATIONS} invocations`,
    },
    {
      ...threshold('exceptions', t.exceptions, 'count', MAX_EXCEPTIONS - 1),
      rule: `>= ${MAX_EXCEPTIONS}`,
    },
    threshold('error_logs', t.errorLogs, 'count', MAX_ERROR_LOGS),
    drift(component, t, baselines),
  ];
}

/** Resource kills seen by tail outcomes plus the platform's own periodic count. */
function kills(component: keyof Analytics['objectKills'], s: Snapshot): Signal {
  const fromTail = s.tail[component]?.resourceKills ?? 0;
  return threshold(
    'resource_kills',
    fromTail + (s.analytics?.objectKills[component] ?? 0),
    'count',
    0,
  );
}

function report(
  component: Component,
  s: Snapshot,
  signals: Signal[],
  watched = true,
): ComponentReport {
  return {
    component,
    watched,
    signals,
    anomalous: signals.some((x) => x.anomalous),
    samples: s.tail[component as TailComponent]?.samples ?? [],
  };
}

function queueSignals(a: Analytics): Signal[] {
  const q = a.queue;
  return [
    threshold('backlog', q.backlogLatest, 'messages', MAX_BACKLOG),
    {
      name: 'backlog_growth',
      value: q.backlogLatest - q.backlogEarliest,
      unit: 'messages',
      anomalous: q.backlogLatest > 10 && q.backlogLatest > 2 * Math.max(q.backlogEarliest, 1),
      rule: 'latest > 2x window start and > 10',
    },
    threshold('dead_letter_backlog', q.deadLetterBacklog, 'messages', 0),
    threshold('dead_lettered', q.deadLettered, 'messages', 0),
    threshold('lag_ms', q.lagMs, 'ms', MAX_LAG_MS),
    threshold('retries_per_message', q.retries, 'avg', MAX_RETRIES),
  ];
}

/** Evaluates every component's rules against one snapshot. */
export function evaluate(s: Snapshot, baselines: Baselines): ComponentReport[] {
  const a = s.analytics;
  return [
    report('api_worker', s, [
      ...invocationSignals('api_worker', s, baselines),
      {
        name: 'health',
        value: s.health.status,
        unit: 'http_status',
        anomalous: !s.health.ok,
        rule: '/health must answer 200 as yonedarepo-platform',
      },
    ]),
    // Commit and land both run inside the repository authority.
    report('source_repository', s, [
      ...invocationSignals('source_repository', s, baselines),
      kills('source_repository', s),
    ]),
    // Retries are logged when Artifacts refuses a push (receive-pack busy) and it is resent.
    report('object_push_queue', s, [
      ...invocationSignals('object_push_queue', s, baselines),
      kills('object_push_queue', s),
      threshold(
        'push_retries',
        s.tail.object_push_queue?.pushRetries ?? 0,
        'count',
        MAX_PUSH_RETRIES,
      ),
    ]),
    // The per-branch land queue is SQL state inside SourceRepository; no external counter yet.
    report('land_queue', s, [], false),
    report('check_runs', s, [
      ...invocationSignals('check_runs', s, baselines),
      kills('check_runs', s),
      ...(a
        ? [
            threshold(
              'container_disk_percent',
              a.containers.maxDiskPercent,
              'percent',
              MAX_DISK_PERCENT,
            ),
          ]
        : []),
    ]),
    report('derived_jobs', s, [
      ...invocationSignals('derived_jobs', s, baselines),
      ...(a ? queueSignals(a) : []),
    ]),
  ];
}

/** Baseline updates from this run: only latency samples of components that were quiet. */
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
