// Deterministic signals per platform component. A model is consulted only when one of these
// rules fires, so a quiet platform costs nothing. Invocation signals come from tail events;
// queue, resource-kill and disk signals from analytics, and are omitted (not read as quiet)
// when analytics is unavailable. Latency rules compare against a stored baseline: an EWMA
// fed only by quiet runs, so an incident cannot become the new normal. Marks are log events
// counted by name, read over a longer window: they are logged once, and must not be missed.
import { deliveryReports } from './delivery';
import type { Level, Observation } from './ledger';
import { releaseReports } from './release';
import {
  type Baselines,
  backlogSignals,
  baselineKey,
  type Component,
  type ComponentReport,
  healthSignal,
  invocationSignals,
  kills,
  marked,
  named,
  queueSignals,
  report,
  type Signal,
  type Snapshot,
  threshold,
} from './signal-rules';
import { landQueue, wideReports } from './signals-wide';

export type { Baselines, ComponentReport, Snapshot };

const MAX_PUSH_RETRIES = 5;
const MAX_DISK_PERCENT = 85;

/** Signals that send at once on the wide watch: the site is down, money does not add up, or data
 * is at risk. Dead letters are work nothing will retry, and they expire from their queue. */
const URGENT = new Set([
  'health',
  'reconcile_mismatches',
  'storage_9gb',
  'storage_full',
  'audit_event_corrupt',
  'audit_erase_blocked',
  'dead_letter_backlog',
  'dead_lettered',
  'delivery_gap',
]);

/** Evaluates every component's rules against one snapshot. */
export function evaluate(s: Snapshot, baselines: Baselines, wide = false): ComponentReport[] {
  const reports = [
    ...platformReports(s, baselines, wide),
    ...releaseReports(s),
    ...deliveryReports(s),
  ];
  if (!wide) return reports;
  return [...reports, ...wideReports(s, baselines)].map((r) => ({
    ...r,
    signals: r.signals.map((x) => (URGENT.has(x.name) ? { ...x, urgent: true } : x)),
  }));
}

function platformReports(s: Snapshot, baselines: Baselines, wide: boolean): ComponentReport[] {
  const a = s.analytics;
  return [
    report('api_worker', s, [
      ...invocationSignals('api_worker', s, baselines),
      healthSignal(s.health, '/health must answer 200 as yonedarepo-platform'),
    ]),
    // Commit and land both run inside the repository authority. A retry is logged when the
    // object store refuses a commit's pack and it is sent again.
    report('source_repository', s, [
      ...invocationSignals('source_repository', s, baselines),
      kills('source_repository', s),
      threshold(
        'push_retries',
        s.tail.source_repository?.pushRetries ?? 0,
        'count',
        MAX_PUSH_RETRIES,
      ),
    ]),
    landQueue(s, baselines, wide),
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
            ...(a.checks ? backlogSignals(a.checks) : []),
          ]
        : []),
    ]),
    report('derived_jobs', s, [
      ...invocationSignals('derived_jobs', s, baselines),
      marked(s, 'compaction_stalls'),
      named(s, 'audit_event_corrupt'),
      named(s, 'audit_erase_blocked'),
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
const dedupKey = (component: Component, fired: Signal[]) =>
  `${component}:${fired
    .map((s) => s.name)
    .sort()
    .join('+')}`;

/**
 * One report's problems. An urgent signal is always its own: a quick pass sees only those, so its
 * finding must keep one identity whatever else the hourly pass finds on that component.
 */
export function problems(r: ComponentReport): { key: string; level: Level; fired: Signal[] }[] {
  const fired = r.signals.filter((s) => s.anomalous);
  const separate = (s: Signal) =>
    s.urgent || s.name === 'p95_execution_ms' || /(?:response|execution)_p95_ms$/.test(s.name);
  const rest = fired.filter((s) => !separate(s));
  const single = fired.filter(separate).map((s) => {
    const level: Level = s.urgent ? 'urgent' : 'digest';
    return { key: dedupKey(r.component, [s]), level, fired: [s] };
  });
  return [
    ...single,
    ...(rest.length
      ? [{ key: dedupKey(r.component, rest), level: 'digest' as const, fired: rest }]
      : []),
  ];
}

/** What the ledger records for one of a report's problems. */
export function observation(
  r: ComponentReport,
  p: ReturnType<typeof problems>[number],
  revision: string | null = null,
): Observation {
  return {
    key: p.key,
    revision,
    component: r.component,
    kind: 'anomaly',
    level: p.level,
    signals: { signals: r.signals, exception_samples: r.samples },
    summary: summary(p.fired),
  };
}

/** A one-line summary built from numbers alone, stored even when no model is consulted. */
function summary(fired: Signal[]) {
  return fired
    .map(
      (s) =>
        `${s.name}=${s.value}${s.unit === 'ms' ? 'ms' : ''} (${s.rule}${s.baseline !== undefined ? `; baseline ${s.baseline}${s.unit === 'ms' ? 'ms' : ''}` : ''}${s.detail ? `; ${s.detail}` : ''})`,
    )
    .join('; ');
}
