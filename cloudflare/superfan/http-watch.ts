import type { SuperfanEnv } from './config';
import type { SuperfanLedger } from './ledger';
import { notifyFindings } from './notify';
import { type ComponentReport, observation, problems } from './signals';

export const RETIRED_LIFETIME_KEYS = [
  'api_worker',
  'source_repository',
  'check_runs',
  'derived_jobs',
  'land_queue',
  'commit_shards',
  'pack_builder',
  'ssh_gateway',
  'ssh_maintenance',
  'workspace_authority',
  'cron',
  'front_worker',
  'managed_worker',
].flatMap((component) =>
  ['p95_wall_ms', 'p95_execution_ms', 'release_p95_ms'].map((signal) => `${component}:${signal}`),
);

/** Tail-only calibrated check. Existing failure/kill/health alarms remain independent. */
export async function watchHttp(
  env: SuperfanEnv,
  ledger: DurableObjectStub<SuperfanLedger>,
  now: number,
  revision: string | null,
) {
  if (env.RESPONSE_LATENCY !== 'on') return;
  const states = await ledger.httpLatency(now);
  // Retire mixed invocation-lifetime rules; retain their history as resolved findings.
  const evaluated = [...RETIRED_LIFETIME_KEYS];
  evaluated.push('front_worker:page_execution_p95_ms', 'front_worker:api_execution_p95_ms');
  const present: string[] = [];
  for (const state of states) {
    // Execution telemetry remains in the ledger; only response-ready latency can alert.
    if (state.metric === 'execution') continue;
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
