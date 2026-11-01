// The quick pass, every five minutes on the wide watch: only the urgent signals, so a site that
// is down reaches a person in minutes rather than at the next hourly pass. It files and resolves
// urgent findings and mails them, and leaves everything else to the hourly pass: no digest and no
// model call (the hourly pass writes the narrative). It takes no run lease: each step is one
// ledger transaction, so overlapping a full pass only counts a finding twice.
import { WINDOW_MS } from './analytics';
import { type SuperfanEnv, wideOn } from './config';
import { readDelivery } from './delivery';
import { notifyUrgent } from './notify';
import { evaluate, observation, problems, type Snapshot } from './signals';
import { MARK_WINDOW_MS } from './tail';
import { productionDeps, siteHealth } from './watch';

/** The cron expression of this pass (the spec's `triggers.crons`); any other runs a full pass. */
export const QUICK_CRON = '*/5 * * * *';

export interface QuickResult {
  outcome: 'ok' | 'off';
  urgent: number;
}

export async function runQuick(env: SuperfanEnv, deps = productionDeps(env)): Promise<QuickResult> {
  const { ledger, target } = deps;
  // A configuration error is the hourly pass's finding; there is nothing to probe here.
  if (!wideOn(env) || target instanceof Error) return { outcome: 'off', urgent: 0 };
  const now = deps.now();
  const start = Math.floor((now - WINDOW_MS) / 60_000) * 60_000;
  const [tail, marks, site, analytics, delivery] = await Promise.all([
    ledger.tailStats(start, now),
    ledger.marks(now - MARK_WINDOW_MS),
    siteHealth(deps, target),
    // The hourly pass reports a telemetry failure; here its signals just stay unevaluated.
    deps.analytics.collect(now).catch(() => null),
    readDelivery(deps.analytics, ledger, now).catch(() => undefined),
  ]);
  const snapshot: Snapshot = {
    window: { start: new Date(start).toISOString(), end: new Date(now).toISOString() },
    ...site,
    tail: tail.components,
    marks,
    analytics,
    ...(delivery === undefined ? {} : { delivery }),
  };
  const revision = site.health.revision ?? (await ledger.latestRevision());
  const evaluated: string[] = [];
  const present: string[] = [];
  for (const report of evaluate(snapshot, {}, true)) {
    for (const s of report.signals) if (s.urgent) evaluated.push(`${report.component}:${s.name}`);
    for (const problem of problems(report).filter((p) => p.level === 'urgent')) {
      present.push(problem.key);
      await ledger.observe(observation(report, problem, revision), now);
    }
  }
  await ledger.resolveAbsent(evaluated, present, now);
  await notifyUrgent(env, ledger, now);
  await ledger.beat(now);
  return { outcome: 'ok', urgent: present.length };
}
