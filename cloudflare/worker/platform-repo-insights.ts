// A repository's Insights (`GET /repos/<id>/insights`): its clones, pushes and landings from
// Analytics Engine and who made its recent commits from the authority. The authority answers
// first, on every view: that is what decides access, so a private repository's figures reach
// nobody it refuses, whatever is held here. Off, an unknown path. Figures are held per isolate for
// a few minutes after that answer, since the SQL API publishes no query rate and a public
// repository's page can be read by anyone. Budget: docs/load-testing.md.
import type {
  InsightsBar,
  InsightsCount,
  RepoInsights,
  RepoUsage,
} from '../../shared/repo-insights';
import { TRAFFIC_RANGES, type TrafficRange } from '../../shared/site-traffic';
import { log } from './log';
import { num, type SqlRow, sqlReader, text } from './platform-analytics-sql';
import { insightsQuery, PUSHES } from './platform-repo-queries';
import { type TrafficSpan, trafficSpan } from './platform-traffic-queries';
import { ApiError, type Json, type RepoContext } from './repo-ops';
import { repoAnalytics } from './repo-usage';
import type { Env } from './types';

const HELD_MS = 5 * 60_000;
const HELD_MOST = 500;
const held = new Map<string, { at: number; rows: SqlRow[] }>();

export const forgetInsights = () => held.clear();

/** The rows of `repo`'s figures over `span`, read at most once every HELD_MS in this isolate. */
async function usageRows(env: Env, repo: string, span: TrafficSpan, fetcher: typeof fetch) {
  const key = `${repo}:${span.range}`;
  const now = Date.now();
  const kept = held.get(key);
  if (kept && now - kept.at < HELD_MS) return kept.rows;
  const sql = sqlReader(env, fetcher);
  if (!sql) return null;
  const rows = await sql.run(insightsQuery(sql.dataset, repo, span));
  held.delete(key);
  held.set(key, { at: now, rows });
  if (held.size > HELD_MOST) held.delete(held.keys().next().value as string);
  return rows;
}

const WHO: Record<string, string> = {
  person: 'person',
  personal_token: 'token',
  repo_token: 'token',
  platform: 'platform',
  anonymous: 'anonymous',
};

/** A count per key, busiest first. */
function tally(rows: { key: string; count: number; estimated: boolean }[]): InsightsCount[] {
  const found = new Map<string, InsightsCount>();
  for (const { key, count, estimated } of rows) {
    const was = found.get(key) ?? { key, count: 0, estimated: false };
    found.set(key, { key, count: was.count + count, estimated: was.estimated || estimated });
  }
  return [...found.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Rows folded into totals and `span`'s bars, counted back from its end. */
export function foldUsage(rows: SqlRow[], span: TrafficSpan): RepoUsage {
  const seen = rows.map((r) => ({
    at: Date.parse(`${text(r.bucket)}:00:00Z`),
    actor: text(r.actor),
    reason: text(r.reason),
    detail: text(r.detail),
    count: num(r.count),
    estimated: num(r.sampling) > 1,
  }));
  const refused = (d: string) => d === 'refused' || d === 'failed';
  const sum = (test: (detail: string) => boolean, from = seen) =>
    from.filter((r) => test(r.detail)).reduce((n, r) => n + r.count, 0);
  const last = span.buckets - 1;
  const bars: (typeof seen)[] = Array.from({ length: span.buckets }, () => []);
  for (const r of seen) bars[last - Math.floor((span.close - 1 - r.at) / span.bucket_ms)]?.push(r);
  const series: InsightsBar[] = bars.map((bar, i) => {
    const end = span.close - (last - i) * span.bucket_ms;
    return {
      start: new Date(Math.max(end - span.bucket_ms, span.start)).toISOString(),
      end: new Date(end).toISOString(),
      clones: sum((d) => d === 'clone', bar),
      pushes: sum((d) => PUSHES.includes(d), bar),
      landings: sum((d) => d === 'landed', bar),
      failed: sum(refused, bar),
      estimated: bar.some((r) => r.estimated),
    };
  });
  const actions = seen.filter((r) => r.detail !== 'already');
  const failures = seen.filter((r) => refused(r.detail));
  return {
    clones: sum((d) => d === 'clone'),
    fetches: sum((d) => d === 'fetch'),
    pushes: sum((d) => PUSHES.includes(d)),
    landings: sum((d) => d === 'landed'),
    failed_landings: sum(refused),
    estimated: seen.some((r) => r.estimated),
    bucket: span.bucket,
    series,
    who: tally(actions.map((r) => ({ ...r, key: WHO[r.actor] ?? 'token' }))),
    reasons: tally(failures.map((r) => ({ ...r, key: r.reason || 'unknown' }))),
  };
}

const rangeOf = (value: unknown): TrafficRange =>
  TRAFFIC_RANGES.find((range) => range === value) ?? '30d';

/** `GET insights?range=`. The window starts where the chart does, so its figures are the bars'. */
export async function repoInsights(
  ctx: RepoContext,
  query: Json,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RepoInsights> {
  if (!repoAnalytics(ctx.env)) throw new ApiError('NOT_FOUND', 'Unknown API path');
  const range = rangeOf(query.range);
  const span = trafficSpan(range, now);
  // Refuses anyone who can't read the whole repository: nothing below runs for them.
  const { contributors, more } = await ctx.call({ op: 'repo_insights', since: span.start });
  let usage: RepoUsage | null = null;
  try {
    const rows = await usageRows(ctx.env, ctx.repo, span, fetcher);
    usage = rows && foldUsage(rows, span);
  } catch (e) {
    log.error('repo_insights.failed', { repo: ctx.repo, error: e });
  }
  return { range, ranges: TRAFFIC_RANGES, usage, contributors, more };
}
