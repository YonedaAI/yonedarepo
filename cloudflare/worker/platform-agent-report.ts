// The admin Agents tab (AGENT_REPORT): what agent credentials did, from the points recordClient
// writes for them. Credentials are the measure, since one can run many processes, and client names
// are the agents' own word. One row for each credential, half hour and client gives everything
// that adds up, folded here; repositories and the busiest minute don't add up, so each has its own
// statement. All of it counts stored rows, so a sampled answer is marked as an estimate. Which
// repositories are organizations' comes from D1. Budget: docs/load-testing.md.
import type { AgentClientRow, AgentReport, AgentResult } from '../../shared/platform-reports';
import { TRAFFIC_RANGES, type TrafficRange } from '../../shared/site-traffic';
import { log } from './log';
import { num, type SqlRow, sqlReader, text } from './platform-analytics-sql';
import { type TrafficSpan, trafficSpan } from './platform-traffic-queries';
import { agentReport } from './repo-usage';
import { SITE_EVENT_BLOBS as B, SITE_EVENT_MARKED, SITE_EVENT_RETRIES } from './site-events';
import type { Env } from './types';

const LIMIT = 20_000;
const REACHED_LIMIT = 1_000;

const rangeOf = (value: string | null): TrafficRange =>
  TRAFFIC_RANGES.find((range) => range === value) ?? '7d';

/** An agent's point stands for one request (`recordClient` writes them all), so only Analytics
 * Engine's own sampling weighs it. */
const count = (condition: string, name: string) =>
  `SUM(_sample_interval * if(${condition}, 1, 0)) AS ${name}`;
const SAMPLING = 'MAX(_sample_interval) AS sampling';
const points = (span: TrafficSpan) =>
  `${B.event} = 'client' AND ${SITE_EVENT_MARKED} = 1 AND ${B.actor} = 'agent' AND ${B.credential} != '' AND timestamp >= toDateTime(${Math.floor(span.start / 1000)})`;

/** One row for each credential, half hour on the clock and client it named. */
export function agentsQuery(dataset: string, span: TrafficSpan) {
  const figures = [
    'SUM(_sample_interval) AS requests',
    count(`${B.operation} IN ('read', 'clone')`, 'reads'),
    count(`${B.operation} IN ('write', 'push')`, 'writes'),
    count(`${B.operation} = 'mcp'`, 'mcp'),
    count(`${B.detail} = 'landed'`, 'landed'),
    count(`${B.detail} = 'refused'`, 'refused'),
    count(`${B.detail} = 'failed'`, 'failed'),
    count(`${B.detail} = 'already'`, 'already'),
    `SUM(_sample_interval * ${SITE_EVENT_RETRIES}) AS retries`,
    count(`${B.outcome} != 'success'`, 'failures'),
    count(`${B.outcome} = 'unauthorized'`, 'unauthorized'),
    count(`${B.outcome} = 'rate_limited'`, 'rate_limited'),
    SAMPLING,
  ];
  const slot = `toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '30' MINUTE))`;
  return `SELECT ${B.credential} AS credential, ${slot} AS slot, ${B.agentClient} AS client, ${figures.join(', ')} FROM ${dataset} WHERE ${points(span)} GROUP BY credential, slot, client ORDER BY slot DESC LIMIT ${LIMIT} FORMAT JSON`;
}

/** The repositories agents reached. */
export function reachedQuery(dataset: string, span: TrafficSpan) {
  return `SELECT ${B.repo} AS repo, ${SAMPLING} FROM ${dataset} WHERE ${points(span)} AND ${B.repo} != '' GROUP BY repo ORDER BY repo LIMIT ${REACHED_LIMIT} FORMAT JSON`;
}

/** The minute with the most credentials. */
export function peakQuery(dataset: string, span: TrafficSpan) {
  const minute = `toStartOfInterval(timestamp, INTERVAL '1' MINUTE)`;
  return `SELECT ${minute} AS minute, COUNT(DISTINCT ${B.credential}) AS credentials, ${SAMPLING} FROM ${dataset} WHERE ${points(span)} GROUP BY minute ORDER BY credentials DESC LIMIT 1 FORMAT JSON`;
}

/** The sum of `key` over `rows`. */
const total = (rows: SqlRow[], key: string) => rows.reduce((n, r) => n + num(r[key]), 0);

function byClient(rows: SqlRow[], estimated: boolean): AgentClientRow[] {
  const found = new Map<string, { credentials: Set<string>; requests: number; landings: number }>();
  for (const r of rows) {
    const client = text(r.client);
    const held = found.get(client) ?? { credentials: new Set(), requests: 0, landings: 0 };
    held.credentials.add(text(r.credential));
    held.requests += num(r.requests);
    held.landings += num(r.landed);
    found.set(client, held);
  }
  return [...found]
    .map(([client, c]) => ({
      client,
      credentials: c.credentials.size,
      requests: c.requests,
      landings: c.landings,
      estimated,
    }))
    .sort((a, b) => b.requests - a.requests || a.client.localeCompare(b.client));
}

/** The three statements and the organizations' count, folded. */
export function foldAgents(
  rows: SqlRow[],
  reached: SqlRow[],
  peak: SqlRow[],
  organizations: number,
  span: TrafficSpan,
): AgentReport {
  const sampled = [...rows, ...reached, ...peak].some((r) => num(r.sampling) > 1);
  const estimated = sampled || rows.length >= LIMIT || reached.length >= REACHED_LIMIT;
  const last = span.buckets - 1;
  const bars = Array.from({ length: span.buckets }, () => new Set<string>());
  const credentials = new Set<string>();
  const sessions = new Set<string>();
  for (const r of rows) {
    const credential = text(r.credential);
    // A half hour can start before the range does.
    const at = Math.max(num(r.slot) * 1000, span.start);
    credentials.add(credential);
    sessions.add(`${credential}:${num(r.slot)}`);
    bars[last - Math.floor((span.close - 1 - at) / span.bucket_ms)]?.add(credential);
  }
  const landings = total(rows, 'landed');
  const asked = landings + total(rows, 'refused') + total(rows, 'failed');
  const repeated = total(rows, 'retries') + total(rows, 'already');
  return {
    range: span.range,
    credentials: credentials.size,
    sessions: sessions.size,
    repositories: reached.length,
    organizations,
    concurrency: num(peak[0]?.credentials),
    reads: total(rows, 'reads'),
    writes: total(rows, 'writes'),
    mcp_calls: total(rows, 'mcp'),
    landings,
    landings_refused: total(rows, 'refused'),
    landings_failed: total(rows, 'failed'),
    failures: total(rows, 'failures'),
    unauthorized: total(rows, 'unauthorized'),
    rate_limited: total(rows, 'rate_limited'),
    success_rate: asked ? landings / asked : null,
    retry_rate: asked ? repeated / asked : null,
    estimated,
    bucket: span.bucket,
    series: bars.map((bar, i) => {
      const end = span.close - (last - i) * span.bucket_ms;
      return {
        start: new Date(Math.max(end - span.bucket_ms, span.start)).toISOString(),
        end: new Date(end).toISOString(),
        credentials: bar.size,
        estimated,
      };
    }),
    clients: byClient(rows, estimated),
  };
}

/** How many organizations own `repos`. Only people have an account row (migration 0009). */
async function owningOrganizations(env: Env, repos: string[]) {
  if (!repos.length) return 0;
  const row = await env.INDEX.prepare(
    `SELECT COUNT(DISTINCT r.workspace) AS organizations FROM platform_repos r
       WHERE r.id IN (SELECT value FROM json_each(?1))
         AND r.workspace NOT IN (SELECT account FROM platform_accounts)`,
  )
    .bind(JSON.stringify(repos))
    .first<{ organizations: number }>();
  return num(row?.organizations);
}

/** `GET agents?range=`. */
export async function agentView(
  env: Env,
  query: URLSearchParams,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<AgentResult> {
  if (!agentReport(env)) return { ok: false, reason: 'off' };
  const sql = sqlReader(env, fetcher);
  if (!sql) return { ok: false, reason: 'not_configured' };
  const span = trafficSpan(rangeOf(query.get('range')), now);
  try {
    const [rows, reached, peak] = await Promise.all([
      sql.run(agentsQuery(sql.dataset, span)),
      sql.run(reachedQuery(sql.dataset, span)),
      sql.run(peakQuery(sql.dataset, span)),
    ]);
    const owners = await owningOrganizations(
      env,
      reached.map((r) => text(r.repo)),
    );
    return { ok: true, report: foldAgents(rows, reached, peak, owners, span) };
  } catch (e) {
    log.error('agent_report.failed', { error: e });
    return { ok: false, reason: 'query_failed' };
  }
}
