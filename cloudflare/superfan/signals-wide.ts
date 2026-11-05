// What the wide watch adds to the platform's reports: the rest of the platform, the other
// Workers, money and storage. Levels are set in signals.ts.

import type { AuthorityAnalytics } from './analytics';
import {
  type Baselines,
  backlogSignals,
  type ComponentReport,
  healthSignal,
  invocationSignals,
  marked,
  queueSignals,
  report,
  type Snapshot,
  threshold,
} from './signal-rules';
import type { TailComponent } from './tail';

const MAX_LAND_FAILURES = 5;
const MAX_LAND_TIMEOUTS = 10;
/** The dead-man checks every five minutes. */
const MAX_DEADMAN_AGE_MIN = 20;

/** A class with no signals of its own: its invocations and what killed them. */
function objectReport(component: TailComponent, s: Snapshot, baselines: Baselines) {
  return report(component, s, [
    ...invocationSignals(component, s, baselines),
    threshold('resource_kills', s.tail[component]?.resourceKills ?? 0, 'count', 0),
  ]);
}

/** What the wide watch adds: the rest of the platform, the other Workers, money and storage. */
export function wideReports(s: Snapshot, baselines: Baselines): ComponentReport[] {
  const a = s.analytics;
  const cronRuns = s.tail.cron?.invocations ?? 0;
  return [
    report(
      'backend_execution',
      s,
      [
        ...invocationSignals('backend_execution', s, baselines).filter(
          (signal) => signal.name === 'exceptions' || signal.name === 'error_logs',
        ),
        threshold('resource_kills', s.tail.backend_execution?.resourceKills ?? 0, 'count', 0),
        marked(s, 'backend_deaths'),
      ],
      Boolean(s.tail.backend_execution),
    ),
    report(
      'regional_resources',
      s,
      a?.regional?.weur ? regionalSignals(a.regional.weur) : [],
      Boolean(a?.regional?.weur),
    ),
    objectReport('commit_shards', s, baselines),
    objectReport('workspace_authority', s, baselines),
    objectReport('pack_builder', s, baselines),
    objectReport('ssh_gateway', s, baselines),
    // Background alarms have no user-request denominator. Retain each error and sample;
    // the existing >=3 exceptions / >5 error logs / any resource kill rules still apply.
    report('ssh_maintenance', s, [
      ...invocationSignals('ssh_maintenance', s, baselines).filter(
        (signal) => signal.name === 'exceptions' || signal.name === 'error_logs',
      ),
      threshold('resource_kills', s.tail.ssh_maintenance?.resourceKills ?? 0, 'count', 0),
    ]),
    report('cron', s, [
      threshold(
        'failed_crons',
        (s.tail.cron?.errors ?? 0) + (s.marks.cron_failures ?? 0),
        'count',
        0,
      ),
      {
        name: 'cron_missing',
        value: cronRuns,
        unit: 'count',
        // Silence alone proves nothing while no tail event arrives at all (telemetry says so).
        anomalous: cronRuns === 0 && Object.keys(s.tail).length > 0,
        rule: 'no cron run this hour',
      },
    ]),
    report('front_worker', s, [
      ...invocationSignals('front_worker', s, baselines),
      ...(s.frontHealth
        ? [healthSignal(s.frontHealth, '/health must answer 200 as yonedarepo')]
        : []),
    ]),
    report('managed_worker', s, [
      ...invocationSignals('managed_worker', s, baselines),
      ...(a?.managed
        ? [
            ...backlogSignals(a.managed),
            threshold('dead_letter_backlog', a.managed.deadLetterBacklog, 'messages', 0),
          ]
        : []),
    ]),
    report('billing', s, [marked(s, 'reconcile_mismatches')]),
    report('storage', s, [
      marked(s, 'storage_8gb'),
      marked(s, 'storage_9gb'),
      marked(s, 'storage_full'),
    ]),
    ...(s.deadmanAge === undefined
      ? []
      : [
          report('deadman', s, [
            {
              name: 'deadman_stale',
              value: s.deadmanAge,
              unit: 'minutes',
              anomalous: s.deadmanAge === null || s.deadmanAge > MAX_DEADMAN_AGE_MIN,
              rule: `last check under ${MAX_DEADMAN_AGE_MIN} minutes ago`,
            },
          ]),
        ]),
  ];
}

/** The land queue's tickets are SQL inside each SourceRepository, with no counter outside it, so
 * it is watched by its combiners: their invocations, batches that failed, landers left waiting. */
export function landQueue(s: Snapshot, baselines: Baselines, wide: boolean) {
  if (!wide) return report('land_queue', s, [], false);
  return report('land_queue', s, [
    ...invocationSignals('land_queue', s, baselines),
    threshold('land_failures', s.marks.land_failures ?? 0, 'count', MAX_LAND_FAILURES),
    threshold('land_timeouts', s.marks.land_timeouts ?? 0, 'count', MAX_LAND_TIMEOUTS),
  ]);
}

/** Regional jobs/checks share one DLQ; combine their work, not US resource samples. */
function regionalSignals(a: AuthorityAnalytics) {
  const checks = a.checks;
  const maximum = (values: (number | null)[]) => {
    const present = values.filter((v): v is number => v !== null);
    return present.length ? Math.max(...present) : null;
  };
  const queue = {
    ...a.queue,
    backlogLatest: a.queue.backlogLatest + (checks?.backlogLatest ?? 0),
    backlogEarliest: a.queue.backlogEarliest + (checks?.backlogEarliest ?? 0),
    deadLettered: a.queue.deadLettered + (checks?.deadLettered ?? 0),
    lagMs: maximum([a.queue.lagMs, checks?.lagMs ?? null]),
    retries: maximum([a.queue.retries, checks?.retries ?? null]),
  };
  return [
    ...queueSignals({ queue }),
    threshold(
      'resource_kills',
      a.objectKills.source_repository + a.objectKills.check_runs,
      'count',
      0,
    ),
    threshold('container_disk_percent', a.containers.maxDiskPercent, 'percent', 85),
  ];
}
