import type { SuperfanEnv } from './config';
import type { SuperfanLedger } from './ledger';
import { notifyFindings } from './notify';
import { type ComponentReport, observation, problems } from './signals';

export const LEGACY_LATENCY_KEYS = [
  'api_worker',
  'source_repository',
  'check_runs',
  'derived_jobs',
  'land_queue',
  'commit_shards',
  'pack_builder',
  'ssh_gateway',
  'workspace_authority',
  'cron',
  'front_worker',
  'managed_worker',
].map((component) => `${component}:p95_wall_ms`);

/** Tail-only calibrated check. Existing failure/kill/health alarms remain independent. */
export async function watchHttp(
  env: SuperfanEnv,
  ledger: DurableObjectStub<SuperfanLedger>,
  now: number,
  revision: string | null,
) {
  if (env.RESPONSE_LATENCY !== 'on') return;
  const states = await ledger.httpLatency(now);
  // Retire the old mixed-workload rule; retain its history as a resolved finding.
  const evaluated = [...LEGACY_LATENCY_KEYS];
  const present: string[] = [];
  for (const state of states) {
    // No traffic does not prove recovery and cannot resolve an established alert.
    if (state.status !== 'ready') continue;
    const name = `${state.traffic}_${state.metric}_p95_ms`;
    const detail = `${state.requests} successful requests; 5-minute window ending ${new Date(state.window_end).toISOString()}; ${state.baseline_windows} baseline windows spanning at least 24 hours. Two consecutive degraded windows required.`;
    const report: ComponentReport = {
      component: 'front_worker',
      watched: true,
      samples: [],
      anomalous: state.anomalous,
      signals: [
        {
          name,
          value: state.p95_ms,
          unit: 'ms',
          anomalous: state.anomalous,
          rule: `> measured upper band ${state.threshold_ms} ms in two distinct 5-minute windows`,
          baseline: state.baseline_ms ?? undefined,
          detail,
        },
      ],
    };
    evaluated.push(`front_worker:${name}`);
    for (const problem of problems(report)) {
      present.push(problem.key);
      await ledger.observe(observation(report, problem, revision), now);
    }
  }
  await ledger.resolveAbsent(evaluated, present, now);
  await notifyFindings(env, ledger, now);
}
