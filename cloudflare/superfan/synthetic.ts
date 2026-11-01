// The synthetic pass, on the five-minute cron: the checks in synthetic-checks.ts, from outside the
// platform, on dev and prod alike, because the wide watch is not on prod. Two failed passes in a row
// are one urgent finding per check, mailed at once; a check that recovers ends its finding. It sits
// beside the quick pass, sharing no state with it, and stops at its own switch: PROBES off spends no
// request and no ledger call. Only dev ever lands (PROBE_LANDING), every third pass.
import { probesOn, type SuperfanEnv } from './config';
import type { LatestProbes, ProbeRow } from './ledger-probes';
import { notifyUrgent } from './notify';
import type { ComponentReport, Signal } from './signal-rules';
import { observation, problems } from './signals';
import {
  PROBE_CHECKS,
  type ProbeCheck,
  type ProbeResult,
  type ProbeTargets,
  runCheck,
} from './synthetic-checks';
import { productionDeps } from './watch';

const MINUTE = 60_000;
const PASS_MS = 5 * MINUTE;
const LAND_EVERY_PASSES = 3;
/** Passes in a row that must fail. A check that never ran, or stopped running, says nothing. */
const STREAK = 2;
const STALE_MS = 40 * MINUTE;
const LANDS_ON = 'yonedarepo-dev-platform';

export interface SyntheticResult {
  checks: number;
  failing: number;
}

function signal(check: ProbeCheck, rows: ProbeRow[], now: number): Signal {
  const fresh = rows.filter((r) => now - r.at <= STALE_MS);
  return {
    name: `probe_${check}`,
    value: fresh[0]?.status ?? null,
    unit: 'http_status',
    anomalous: fresh.length >= STREAK && fresh.every((r) => !r.ok),
    rule: `fails ${STREAK} passes in a row`,
    urgent: true,
  };
}

export function syntheticReport(latest: LatestProbes, now: number): ComponentReport {
  const signals = PROBE_CHECKS.map((check) => signal(check, latest[check] ?? [], now));
  return {
    component: 'synthetic',
    watched: true,
    signals,
    anomalous: signals.some((s) => s.anomalous),
    samples: [],
  };
}

/** The checks due this pass, and what they need. An unset repository leaves its check out. */
function due(env: SuperfanEnv, targets: ProbeTargets, now: number): ProbeCheck[] {
  const landing =
    env.WATCH_SCRIPT === LANDS_ON &&
    env.PROBE_LANDING === 'on' &&
    targets.land &&
    Math.floor(now / PASS_MS) % LAND_EVERY_PASSES === 0;
  return [
    'health',
    'page',
    'api',
    ...(targets.cloneRepo ? (['clone'] as const) : []),
    ...(landing ? (['land'] as const) : []),
  ];
}

function targetsOf(env: SuperfanEnv, front: string, health: string): ProbeTargets {
  const land =
    env.PROBE_LAND_REPO && env.PROBE_LAND_TOKEN
      ? { repo: env.PROBE_LAND_REPO.trim(), token: env.PROBE_LAND_TOKEN.trim() }
      : undefined;
  return {
    front: new URL(front).origin,
    api: new URL(health).origin,
    cloneRepo: env.PROBE_CLONE_REPO?.trim() || undefined,
    land,
  };
}

/** One pass; null with the switch off or a configuration error, which the hourly pass reports. */
export async function runProbes(
  env: SuperfanEnv,
  deps = productionDeps(env),
): Promise<SyntheticResult | null> {
  const { ledger, target } = deps;
  if (!probesOn(env) || target instanceof Error || !target.frontHealthUrl) return null;
  const now = deps.now();
  const targets = targetsOf(env, target.frontHealthUrl, target.healthUrl);
  const results: ProbeResult[] = await Promise.all(
    due(env, targets, now).map((check) => runCheck(check, targets, deps.pause)),
  );
  const report = syntheticReport(await ledger.recordProbes(results, now), now);
  const found = problems(report);
  const seen = results.find((r) => r.revision)?.revision;
  const revision = seen ?? (found.length ? await ledger.latestRevision() : null);
  for (const problem of found) await ledger.observe(observation(report, problem, revision), now);
  await ledger.resolveAbsent(
    report.signals.map((s) => `synthetic:${s.name}`),
    found.map((p) => p.key),
    now,
  );
  await notifyUrgent(env, ledger, now);
  return { checks: results.length, failing: found.length };
}
