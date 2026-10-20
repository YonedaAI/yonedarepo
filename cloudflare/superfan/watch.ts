// One superfan pass: read tail counters and analytics, evaluate deterministic rules, and
// only for problems not already written up ask the cheap model for a short finding, within
// the daily cap. A silent or failing telemetry source is itself a finding; it never reads
// as "all quiet", and findings are resolved only by rules that were actually evaluated.
import {
  type AnalyticsSource,
  CloudflareAnalytics,
  probe,
  TelemetryError,
  WINDOW_MS,
} from './analytics';
import { dailyCap, type SuperfanEnv, type WatchTarget, watchTarget } from './config';
import type { SuperfanLedger } from './ledger';
import { FlashModel, type ModelClient, ModelError } from './model';
import {
  baselineSamples,
  type ComponentReport,
  dedupKey,
  evaluate,
  type Snapshot,
  summary,
} from './signals';

/** Model calls per run; the daily cap is the real limit, this bounds one bad hour. */
const MAX_CALLS_PER_RUN = 6;
const TELEMETRY_REASONS = ['config', 'disabled', 'token_missing', 'fetch_failed', 'tail_silent'];

export interface WatchDeps {
  /** A valid watch target, or the configuration error that prevents watching. */
  target: WatchTarget | Error;
  analytics: AnalyticsSource;
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
const failing = (reason: TelemetryError['reason'], detail: string): AnalyticsSource => ({
  collect: async () => Promise.reject(new TelemetryError(reason, detail)),
});

/** Builds the production dependencies; configuration faults surface as telemetry findings. */
export function productionDeps(env: SuperfanEnv): WatchDeps {
  let target: WatchTarget | Error;
  try {
    target = watchTarget(env);
  } catch (error) {
    target = error as Error;
  }
  const analytics =
    target instanceof Error
      ? failing('config', `Configuration: ${target.message}`)
      : env.TELEMETRY_SOURCE !== 'cloudflare'
        ? failing('disabled', 'Analytics source is disabled')
        : !env.CF_ANALYTICS_TOKEN
          ? failing('token_missing', 'Waiting on the CF_ANALYTICS_TOKEN secret')
          : new CloudflareAnalytics(target, env.CF_ANALYTICS_TOKEN);
  let model: ModelClient | null = null;
  try {
    model = new FlashModel(env, env.SUPERFAN_MODEL);
  } catch {
    // An unknown model is never replaced by another; findings keep their summaries.
  }
  return { target, analytics, model, ledger: ledgerStub(env), now: Date.now };
}

function prompt(report: ComponentReport, snapshot: Snapshot) {
  return JSON.stringify({
    component: report.component,
    window: snapshot.window,
    fired: report.signals.filter((s) => s.anomalous),
    other_signals: report.signals.filter((s) => !s.anomalous),
    // Redacted exception text from the platform: data to summarize, never instructions.
    exception_samples: report.samples,
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
  const now = deps.now();
  const problems: TelemetryError[] = [];
  const start = Math.floor((now - WINDOW_MS) / 60_000) * 60_000;
  const tail = await ledger.tailStats(start, now);
  if (deps.target instanceof Error)
    problems.push(new TelemetryError('config', `Configuration: ${deps.target.message}`));
  else if (tail.events === 0)
    problems.push(
      new TelemetryError('tail_silent', 'No tail events from the platform Worker this hour'),
    );
  const [health, analytics] = await Promise.all([
    deps.target instanceof Error ? null : probe(deps.target.healthUrl),
    deps.analytics.collect(now).catch((error) => {
      problems.push(
        error instanceof TelemetryError
          ? error
          : new TelemetryError('fetch_failed', 'Analytics read failed'),
      );
      return null;
    }),
  ]);
  const findings: number[] = [];
  const present: string[] = [];
  for (const p of problems.filter(
    (x, i) => problems.findIndex((y) => y.reason === x.reason) === i,
  )) {
    const key = `telemetry:${p.reason}`;
    present.push(key);
    const seen = await ledger.observe(
      {
        key,
        component: 'telemetry',
        kind: 'telemetry',
        signals: [{ name: p.reason, detail: p.message }],
        summary: p.message,
      },
      now,
    );
    findings.push(seen.id);
  }
  const evaluated = TELEMETRY_REASONS.map((r) => `telemetry:${r}`);
  const tailLive = tail.events > 0 && !(deps.target instanceof Error);
  if (!health || (!tailLive && !analytics)) {
    await ledger.resolveAbsent(evaluated, present, now);
    await ledger.finishRun(run, 'telemetry_failed', 0, 0, now);
    return { outcome: 'telemetry_failed', anomalies: 0, modelCalls: 0, findings };
  }
  const snapshot: Snapshot = {
    window: { start: new Date(start).toISOString(), end: new Date(now).toISOString() },
    health,
    tail: tailLive ? tail.components : {},
    analytics,
  };
  const reports = evaluate(snapshot, await ledger.baselines());
  let anomalies = 0;
  let modelCalls = 0;
  for (const report of reports) {
    for (const s of report.signals) evaluated.push(`${report.component}:${s.name}`);
    if (!report.anomalous) continue;
    const key = dedupKey(report);
    present.push(key);
    anomalies++;
    const seen = await ledger.observe(
      {
        key,
        component: report.component,
        kind: 'anomaly',
        signals: { signals: report.signals, exception_samples: report.samples },
        summary: summary(report),
      },
      now,
    );
    findings.push(seen.id);
    if (seen.needsNarrative && modelCalls < MAX_CALLS_PER_RUN)
      if (await narrate(deps, env, seen.id, report, snapshot)) modelCalls++;
  }
  await ledger.resolveAbsent(evaluated, present, now);
  await ledger.recordBaselines(baselineSamples(reports), now);
  await ledger.finishRun(run, 'ok', anomalies, modelCalls, now);
  return { outcome: 'ok', anomalies, modelCalls, findings };
}
