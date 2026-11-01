// The operators' repository reports (platform-admin.ts checks who asks): landings across
// repositories, for the Traffic page, and the Repositories tab's most active and fastest growing,
// named from D1. Accounts that are ours left no client point; a repository token names no account,
// so its points are left out here, by the repository's owner. Budget: docs/load-testing.md.
import type {
  InsightsCount,
  LandingReport,
  LandingReportResult,
  RepoUsageResult,
  RepoUsageRow,
} from '../../shared/repo-insights';
import { TRAFFIC_RANGES, type TrafficRange } from '../../shared/site-traffic';
import { log } from './log';
import { num, type SqlRow, sqlReader, text } from './platform-analytics-sql';
import { landingLatencyQuery, landingTotalsQuery, repoUsageQuery } from './platform-repo-queries';
import { trafficSpan } from './platform-traffic-queries';
import { repoAnalytics } from './repo-usage';
import type { Env } from './types';

const SHOWN = 10;

const rangeOf = (value: string | null): TrafficRange =>
  TRAFFIC_RANGES.find((range) => range === value) ?? '30d';

const estimated = (r: SqlRow) => num(r.sampling) > 1;

/** Folds the two statements into the report. */
export function foldLandings(
  range: TrafficRange,
  totals: SqlRow[],
  times: SqlRow[],
): LandingReport {
  const sum = (test: (r: SqlRow) => boolean) =>
    totals.filter(test).reduce((n, r) => n + num(r.count), 0);
  const is =
    (...details: string[]) =>
    (r: SqlRow) =>
      details.includes(text(r.detail));
  const landed = sum(is('landed'));
  const stopped = sum(is('refused'));
  const failed = sum(is('failed'));
  const asked = landed + stopped + failed;
  const reasons = new Map<string, InsightsCount>();
  for (const r of totals.filter(is('refused', 'failed'))) {
    const key = text(r.reason) || 'unknown';
    const was = reasons.get(key);
    reasons.set(key, {
      key,
      count: (was?.count ?? 0) + num(r.count),
      estimated: (was?.estimated ?? false) || estimated(r),
    });
  }
  const t = times[0] ?? {};
  const pushes = totals.filter(is('base'));
  return {
    range,
    landed,
    refused: stopped,
    failed,
    success_rate: asked ? landed / asked : null,
    latency: landed ? { p50: num(t.p50), p95: num(t.p95), p99: num(t.p99) } : null,
    queue: landed ? { p50: num(t.queue_p50), p95: num(t.queue_p95) } : null,
    retries: totals.reduce((n, r) => n + num(r.retries), 0) + sum(is('already')),
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count),
    checks: { run: sum(is('check:pass', 'check:fail')), failed: sum(is('check:fail')) },
    direct_pushes: {
      total: pushes.reduce((n, r) => n + num(r.count), 0),
      refused: pushes.filter((r) => text(r.reason)).reduce((n, r) => n + num(r.count), 0),
    },
    estimated: totals.some(estimated),
  };
}

/** `GET traffic/landings?range=`. */
export async function landingReport(
  env: Env,
  query: URLSearchParams,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<LandingReportResult> {
  if (!repoAnalytics(env)) return { ok: false, reason: 'off' };
  const sql = sqlReader(env, fetcher);
  if (!sql) return { ok: false, reason: 'not_configured' };
  const range = rangeOf(query.get('range'));
  const span = trafficSpan(range, now);
  try {
    const [totals, times] = await Promise.all([
      sql.run(landingTotalsQuery(sql.dataset, span)),
      sql.run(landingLatencyQuery(sql.dataset, span)),
    ]);
    return { ok: true, report: foldLandings(range, totals, times) };
  } catch (e) {
    log.error('landing_report.failed', { error: e });
    return { ok: false, reason: 'query_failed' };
  }
}

type Listed = {
  id: string;
  name: string;
  owner: string;
  handle: string | null;
  visibility: string;
};

/** Names for `ids`, leaving out what's gone and what's ours. */
async function listed(env: Env, ids: string[]) {
  const { results } = await env.INDEX.prepare(
    `SELECT r.id,r.name,r.workspace AS owner,COALESCE(h.handle,
       CASE WHEN instr(r.workspace,'@')=0 THEN r.workspace END) AS handle,r.visibility
       FROM platform_repos r LEFT JOIN platform_handles h ON h.workspace=r.workspace
       WHERE r.id IN (SELECT value FROM json_each(?1))
         AND r.workspace NOT IN (SELECT account FROM platform_accounts WHERE internal=1)`,
  )
    .bind(JSON.stringify(ids))
    .all<Listed>();
  return new Map(results.map((r) => [r.id, r]));
}

function rows(found: SqlRow[], names: Map<string, Listed>): RepoUsageRow[] {
  return found.flatMap((r) => {
    const name = names.get(text(r.repo));
    if (!name) return [];
    return [
      {
        ...name,
        visibility: name.visibility === 'public' ? ('public' as const) : ('private' as const),
        actions: num(r.actions),
        pushed_bytes: num(r.pushed_bytes),
        estimated: estimated(r),
      },
    ];
  });
}

/** `GET repos/usage?range=`. */
export async function repoUsageReport(
  env: Env,
  query: URLSearchParams,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RepoUsageResult> {
  if (!repoAnalytics(env)) return { ok: false, reason: 'off' };
  const sql = sqlReader(env, fetcher);
  if (!sql) return { ok: false, reason: 'not_configured' };
  const range = rangeOf(query.get('range'));
  const span = trafficSpan(range, now);
  try {
    const [active, growing] = await Promise.all([
      sql.run(repoUsageQuery(sql.dataset, span, 'actions')),
      sql.run(repoUsageQuery(sql.dataset, span, 'pushed_bytes')),
    ]);
    const names = await listed(env, [...new Set([...active, ...growing].map((r) => text(r.repo)))]);
    return {
      ok: true,
      report: {
        range,
        most_active: rows(active, names).slice(0, SHOWN),
        fastest_growing: rows(growing, names)
          .filter((r) => r.pushed_bytes > 0)
          .slice(0, SHOWN),
      },
    };
  } catch (e) {
    log.error('repo_usage_report.failed', { error: e });
    return { ok: false, reason: 'query_failed' };
  }
}
