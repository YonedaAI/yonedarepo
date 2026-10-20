// One superfan pass: read telemetry, evaluate deterministic rules, and only for problems
// not already written up ask the cheap model for a short finding, within the daily cap.
// A telemetry failure is itself a finding; it never silently reads as "all quiet".
import { dailyCap, type SuperfanEnv, watchTarget } from './config';
import type { SuperfanLedger } from './ledger';
import { FlashModel, type ModelClient, ModelError } from './model';
import {
  baselineSamples,
  type Component,
  type ComponentReport,
  dedupKey,
  evaluate,
  summary,
} from './signals';
import {
  CloudflareTelemetry,
  type Snapshot,
  TelemetryError,
  type TelemetrySource,
} from './telemetry';

/** Model calls per run; the daily cap is the real limit, this bounds one bad hour. */
const MAX_CALLS_PER_RUN = 6;

export interface WatchDeps {
  telemetry: TelemetrySource;
  model: ModelClient | null;
  ledger: DurableObjectStub<SuperfanLedger>;
  now: () => number;
}
export interface WatchResult {
  outcome: 'ok' | 'telemetry_failed' | 'busy';
  anomalies: number;
  modelCalls: number;
  findings: number[];
}

export const ledgerStub = (env: SuperfanEnv) => env.LEDGER.get(env.LEDGER.idFromName('superfan'));

/** Builds the production dependencies; configuration faults surface as telemetry findings. */
export function productionDeps(env: SuperfanEnv): WatchDeps {
  let telemetry: TelemetrySource;
  if (env.TELEMETRY_SOURCE !== 'cloudflare')
    telemetry = {
      collect: async () =>
        Promise.reject(new TelemetryError('disabled', 'Telemetry source is disabled')),
    };
  else if (!env.CF_ANALYTICS_TOKEN)
    telemetry = {
      collect: async () =>
        Promise.reject(
          new TelemetryError('token_missing', 'Waiting on the CF_ANALYTICS_TOKEN secret'),
        ),
    };
  else {
    try {
      telemetry = new CloudflareTelemetry(watchTarget(env), env.CF_ANALYTICS_TOKEN);
    } catch (error) {
      const detail = `Configuration: ${(error as Error).message}`;
      telemetry = {
        collect: async () => Promise.reject(new TelemetryError('fetch_failed', detail)),
      };
    }
  }
  let model: ModelClient | null = null;
  try {
    model = new FlashModel(env, env.SUPERFAN_MODEL);
  } catch {
    // An unknown model is never replaced by another; findings keep their summaries.
  }
  return { telemetry, model, ledger: ledgerStub(env), now: Date.now };
}

function prompt(report: ComponentReport, snapshot: Snapshot) {
  return JSON.stringify({
    component: report.component,
    window: snapshot.window,
    fired: report.signals.filter((s) => s.anomalous),
    other_signals: report.signals.filter((s) => !s.anomalous),
  });
}

async function narrate(
  deps: WatchDeps,
  env: SuperfanEnv,
  id: number,
  report: ComponentReport,
  snapshot: Snapshot,
): Promise<boolean> {
  const { ledger, model } = deps;
  if (!model) {
    await ledger.annotate(id, 'model_failed', null, env.SUPERFAN_MODEL, 0);
    return false;
  }
  const text = prompt(report, snapshot);
  const reservation = await ledger.reserve(deps.now(), model.worstCase(text), dailyCap(env));
  if (!reservation) {
    await ledger.annotate(id, 'budget_exhausted', null, model.model, 0);
    return false;
  }
  try {
    const reply = await model.write(text);
    const cost = model.cost(reply);
    await ledger.settle(reservation, cost);
    await ledger.annotate(id, 'written', reply.finding, model.model, cost);
  } catch (error) {
    // A request that may have reached the provider keeps its worst-case reservation.
    const kept = error instanceof ModelError && !error.sent ? 0 : model.worstCase(text);
    await ledger.settle(reservation, kept);
    await ledger.annotate(id, 'model_failed', null, model.model, kept);
  }
  return true;
}

export async function runWatch(env: SuperfanEnv, deps = productionDeps(env)): Promise<WatchResult> {
  const run = await deps.ledger.startRun(deps.now());
  if (run === null) return { outcome: 'busy', anomalies: 0, modelCalls: 0, findings: [] };
  try {
    return await pass(env, deps, run);
  } catch (error) {
    await deps.ledger.finishRun(run, 'error', 0, 0, deps.now());
    throw error;
  }
}

async function pass(env: SuperfanEnv, deps: WatchDeps, run: number): Promise<WatchResult> {
  const { ledger } = deps;
  let snapshot: Snapshot;
  try {
    snapshot = await deps.telemetry.collect(deps.now());
  } catch (error) {
    const reason = error instanceof TelemetryError ? error.reason : 'fetch_failed';
    const detail = error instanceof TelemetryError ? error.message : 'Telemetry read failed';
    const seen = await ledger.observe(
      {
        key: `telemetry:${reason}`,
        component: 'telemetry',
        kind: 'telemetry',
        signals: [{ name: reason, detail }],
        summary: detail,
      },
      deps.now(),
    );
    await ledger.resolveAbsent(['telemetry'], [`telemetry:${reason}`], deps.now());
    await ledger.finishRun(run, 'telemetry_failed', 0, 0, deps.now());
    return { outcome: 'telemetry_failed', anomalies: 0, modelCalls: 0, findings: [seen.id] };
  }
  const reports = evaluate(snapshot, await ledger.baselines());
  const present: string[] = [];
  const findings: number[] = [];
  let modelCalls = 0;
  for (const report of reports.filter((r) => r.anomalous)) {
    const key = dedupKey(report);
    present.push(key);
    const seen = await ledger.observe(
      {
        key,
        component: report.component,
        kind: 'anomaly',
        signals: report.signals,
        summary: summary(report),
      },
      deps.now(),
    );
    findings.push(seen.id);
    if (seen.needsNarrative && modelCalls < MAX_CALLS_PER_RUN)
      if (await narrate(deps, env, seen.id, report, snapshot)) modelCalls++;
  }
  const watched: (Component | 'telemetry')[] = [
    'telemetry',
    ...reports.filter((r) => r.watched).map((r) => r.component),
  ];
  await ledger.resolveAbsent(watched, present, deps.now());
  await ledger.recordBaselines(baselineSamples(reports), deps.now());
  await ledger.finishRun(run, 'ok', present.length, modelCalls, deps.now());
  return { outcome: 'ok', anomalies: present.length, modelCalls, findings };
}
