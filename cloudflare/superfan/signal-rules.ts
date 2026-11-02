// The rule primitives: what one signal or one component's report is, and the rules every
// component shares. signals.ts and signals-wide.ts build the reports from them.
import type { Analytics, QueueStats } from './analytics';
import type { Stall } from './delivery';
import type { Health } from './probes';
import type { ReleaseComparison } from './release';
import { NAMED_SEPARATOR, type TailComponent, type TailSample, type TailStats } from './tail';

export type Component = TailComponent | 'billing' | 'storage' | 'deadman' | 'synthetic';

export interface Signal {
  name: string;
  value: number | null;
  unit: string;
  anomalous: boolean;
  rule: string;
  /** Set on the wide watch, for a signal in URGENT. */
  urgent?: boolean;
  baseline?: number;
  /** Set on latency signals with enough traffic to feed the baseline. */
  sample?: number;
  /** Which rows it is about, for a reader: ids only (`NAMING`, tail.ts). */
  detail?: string;
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
  /** Named log events over MARK_WINDOW_MS. */
  marks: Record<string, number>;
  analytics: Analytics | null;
  /** The front Worker's health, on the wide watch. */
  frontHealth?: Health;
  /** Minutes since the dead-man checked; null: unreadable; absent: not watched. */
  deadmanAge?: number | null;
  /** This release against the one before; absent: RELEASE_COMPARE is off. */
  release?: ReleaseComparison;
  /** The worst queue stall in the window; null: none; absent: unread. */
  delivery?: Stall | null;
}
export type Baselines = Record<string, { value: number; samples: number }>;

export const MIN_INVOCATIONS = 20;
export const MAX_ERROR_RATE = 0.02;
export const DRIFT_FACTOR = 2;
/** A p95 rise smaller than this is noise even when it doubles. */
export const DRIFT_FLOOR_MS = 100;
const MIN_BASELINE_SAMPLES = 3;
const MAX_EXCEPTIONS = 3;
const MAX_ERROR_LOGS = 5;
const MAX_BACKLOG = 50;
const MAX_LAG_MS = 120_000;
const MAX_RETRIES = 1;

export const baselineKey = (component: Component, signal: string) => `${component}/${signal}`;

export function threshold(name: string, value: number | null, unit: string, max: number): Signal {
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
export function invocationSignals(
  component: Component,
  s: Snapshot,
  baselines: Baselines,
): Signal[] {
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
export function kills(component: keyof Analytics['objectKills'], s: Snapshot): Signal {
  const fromTail = s.tail[component]?.resourceKills ?? 0;
  return threshold(
    'resource_kills',
    fromTail + (s.analytics?.objectKills[component] ?? 0),
    'count',
    0,
  );
}

export function report(
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

export function backlogSignals(q: QueueStats): Signal[] {
  return [
    threshold('backlog', q.backlogLatest, 'messages', MAX_BACKLOG),
    {
      name: 'backlog_growth',
      value: q.backlogLatest - q.backlogEarliest,
      unit: 'messages',
      anomalous: q.backlogLatest > 10 && q.backlogLatest > 2 * Math.max(q.backlogEarliest, 1),
      rule: 'latest > 2x window start and > 10',
    },
    threshold('dead_lettered', q.deadLettered, 'messages', 0),
  ];
}

export function queueSignals(a: Analytics): Signal[] {
  const q = a.queue;
  return [
    ...backlogSignals(q),
    threshold('dead_letter_backlog', q.deadLetterBacklog, 'messages', 0),
    threshold('lag_ms', q.lagMs, 'ms', MAX_LAG_MS),
    threshold('retries_per_message', q.retries, 'avg', MAX_RETRIES),
  ];
}

/** A log event's count as a signal; one is enough. */
export const marked = (s: Snapshot, name: string) =>
  threshold(name, s.marks[name] ?? 0, 'count', 0);

/** Rows a finding spells out; the rest are counted, and every one is in the logs. */
const NAMED_MAX = 3;

/** A log event's count as a signal, saying which rows its lines named. */
export function named(s: Snapshot, name: string): Signal {
  const prefix = `${name}${NAMED_SEPARATOR}`;
  const rows = Object.keys(s.marks).filter((mark) => mark.startsWith(prefix));
  const count = rows.reduce((sum, mark) => sum + (s.marks[mark] ?? 0), s.marks[name] ?? 0);
  const words = rows.sort().map((mark) => {
    const [, repo, seq] = mark.split(NAMED_SEPARATOR);
    return seq ? `${repo} event ${seq}` : repo;
  });
  const more = words.length - NAMED_MAX;
  const shown = words.slice(0, NAMED_MAX).join(', ');
  const detail = more > 0 ? `${shown} and ${more} more` : shown;
  return { ...threshold(name, count, 'count', 0), ...(detail && { detail }) };
}

export function healthSignal(health: Health, rule: string): Signal {
  return {
    name: 'health',
    value: health.status,
    unit: 'http_status',
    anomalous: !health.ok,
    rule,
  };
}
