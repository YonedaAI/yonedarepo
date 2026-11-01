// What the wide watch adds to the platform's reports: the rest of the platform, the other
// Workers, money and storage. Levels are set in signals.ts.
import {
  type Baselines,
  backlogSignals,
  type ComponentReport,
  healthSignal,
  invocationSignals,
  marked,
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
    objectReport('commit_shards', s, baselines),
    objectReport('workspace_authority', s, baselines),
    objectReport('pack_builder', s, baselines),
    objectReport('ssh_gateway', s, baselines),
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
    report('storage', s, [marked(s, 'storage_8gb'), marked(s, 'storage_9gb')]),
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
