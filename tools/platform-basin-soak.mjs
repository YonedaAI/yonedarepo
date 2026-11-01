#!/usr/bin/env node
// The Basin soak (docs/load-testing.md): do landings counted by Basin match the repository's log
// on dev, and what does the stream cost a day? It only reads: Basin SQL, the repositories' logs
// and cursors, and Cloudflare's metrics. Run it once a day. Evidence: the repository root's
// .local/scale-next/, one file per check. Credentials from ~/.config/yonedarepo (basin.env,
// staging-kit.env, dev-owner.env, staging.env), never printed.
// Usage: node tools/platform-basin-soak.mjs --dry-run | --yes | --gates
//        [--since ISO] [--settle-minutes 15] [--min-landings 100] [--days 2]
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { compareRepo, settledVersion, summarize, windowOf } from './basin-soak/compare.mjs';
import { dayCost, daily, metricReaders, operationsByClass, perRecord } from './basin-soak/cost.mjs';
import { BY_HAND, GATES, judgeGates } from './basin-soak/gates.mjs';
import { evidence, rootLocal } from './fanout-bench/driver.mjs';
import { devSpec, requireDev } from './fanout-bench/guard.mjs';
import { accountSession, CONFIG_DIR, readEnvFile } from './staging/client.mjs';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'https://api.dev.yonedarepo.com' },
    since: { type: 'string', default: new Date(Date.now() - 7 * 86_400_000).toISOString() },
    'settle-minutes': { type: 'string', default: '15' },
    'min-landings': { type: 'string', default: '100' },
    days: { type: 'string', default: '2' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    gates: { type: 'boolean', default: false },
  },
});
const spec = devSpec();
const dir = rootLocal('scale-next');
const BUCKET = 'yonedarepo-dev-change-log';
const PIPELINE = 'yonedarepo_dev_changes_pipeline_v1';
const TABLE = 'platform.changes_v1';
const REPO = /^r[0-9a-f]{20}$/;
const PAGE = 5000;
const MAX_PAGES = 100;

if (values.gates) {
  const names = (await readdir(dir).catch(() => [])).filter((f) => f.startsWith('basin-soak-')).sort();
  const checks = await Promise.all(names.map(async (f) => JSON.parse(await readFile(resolve(dir, f), 'utf8')).result));
  const gates = judgeGates(checks);
  for (const g of gates) console.log(`${g.passed ? 'held' : 'open'}: ${g.name} (${g.saw})`);
  for (const item of BY_HAND) console.log(`by hand: ${item}`);
  process.exit(gates.every((g) => g.passed) ? 0 : 3);
}

const url = values.url.replace(/\/$/, '');
requireDev([url]);
console.error('Basin soak: 1 SQL query for the repositories, 1 to 2 per repository, 2 reads of each repository\'s log and cursor per 500 versions, 5 metric queries. Reads only; 2 sign-ins.');
if (values['dry-run']) process.exit(0);
assert.ok(values.yes, 'Nothing ran. Pass --yes.');

const stored = readEnvFile('basin.env');
const token = stored.BASIN_TOKEN ?? stored.WRANGLER_BASIN_SQL_AUTH_TOKEN;
assert.ok(token, `Set BASIN_TOKEN in ${CONFIG_DIR}/basin.env`);
let scanned = 0;
async function sql(query) {
  const response = await fetch(`https://api.sql.cloudflarestorage.com/api/v1/accounts/${spec.account}/basin-sql/query/${BUCKET}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  });
  const value = await response.json().catch(() => ({}));
  assert.ok(response.ok && value.success !== false, `Basin SQL ${response.status}: ${JSON.stringify(value.errors ?? value).slice(0, 300)}`);
  scanned += Number(value.result?.metrics?.bytes_scanned ?? 0);
  return value.result?.rows ?? value.result ?? [];
}

const since = new Date(values.since).toISOString();
const numbers = (r) => ({ event: r.event, version: Number(r.version), kind: r.kind, commit: r.commit ?? null, merged_landings: Number(r.merged_landings ?? 0) });
async function rowsOf(repo) {
  assert.ok(REPO.test(repo), 'A repository id from the table is not one');
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const part = await sql(`WITH changes AS (SELECT event_key, MAX(event) AS event, MAX(version) AS version, MAX(kind) AS kind, MAX("commit") AS "commit", MAX(merged_landings) AS merged_landings
      FROM ${TABLE} WHERE repo = '${repo}' AND actor_kind <> 'test' GROUP BY event_key)
      SELECT event, version, kind, "commit", merged_landings FROM changes WHERE event <> 'refused' ORDER BY version, event LIMIT ${PAGE} OFFSET ${page * PAGE}`);
    rows.push(...part.map(numbers));
    if (part.length < PAGE) return rows;
  }
  throw new Error(`${repo} has more rows than one check reads`);
}

const kit = readEnvFile('staging-kit.env');
const owner = readEnvFile('dev-owner.env');
const sessions = [await accountSession(url, kit.KIT_USERNAME, kit.KIT_PASSWORD), await accountSession(url, owner.DEV_OWNER_USERNAME, owner.DEV_OWNER_PASSWORD)];
/** The first session that may read `repo`, with its cursor; null for one deleted or not ours. */
async function reader(repo) {
  for (const session of sessions) {
    const answer = await session.raw('GET', `/api/v1/repos/${repo}/changelog`);
    if (answer.ok) return { session, cursor: answer.body };
  }
  return null;
}
async function logOf(session, repo, after, until) {
  const entries = [];
  for (let from = after; from < until; ) {
    const answer = await session.raw('GET', `/api/v1/repos/${repo}/txlog?after=${from}&limit=500`);
    assert.ok(answer.ok, `txlog: ${answer.status}`);
    const page = answer.body.entries.filter((e) => e.version <= until);
    entries.push(...page);
    if (!answer.body.entries.length) break;
    from = answer.body.entries.at(-1).version;
  }
  return entries;
}

const counted = await sql(`SELECT repo, COUNT(*) AS n FROM ${TABLE} WHERE occurred_at >= '${since}' AND actor_kind <> 'test' GROUP BY repo ORDER BY n DESC LIMIT 200`);
const settleMs = Number(values['settle-minutes']) * 60_000;
const repos = [];
const notCompared = [];
for (const { repo, n } of counted) {
  const found = await reader(repo);
  if (!found) {
    notCompared.push({ repo, rows: Number(n) });
    continue;
  }
  const rows = await rowsOf(repo);
  const { session, cursor } = found;
  const low = rows.length ? Math.max(Math.min(...rows.map((r) => r.version)) - 1, cursor.last_gap?.to ?? 0) : 0;
  const all = await logOf(session, repo, low, cursor.version ?? 0);
  const until = settledVersion(all, Date.now() - settleMs);
  const window = windowOf({ rows, cursor, headOfLog: all.at(-1)?.version, settledBefore: until });
  const brief = { sent: cursor.sent, failures: cursor.failures, gaps: cursor.gaps ?? 0, last_gap: cursor.last_gap ?? null, stalled_since: cursor.stalled_since ?? null };
  if (!window) {
    repos.push({ repo, window: null, cursor: brief, ...(cursor.sent > 0 && !rows.length ? { sent_without_rows: true } : {}) });
    continue;
  }
  repos.push({ repo, cursor: brief, ...compareRepo({ entries: all.filter((e) => e.version > window.from && e.version <= window.until), rows, window }) });
}

const summary = summarize(repos, { minLandings: Number(values['min-landings']) });

const { CF_ANALYTICS_TOKEN } = readEnvFile('staging.env', { required: false });
const metrics = { unreadable: {} };
const end = Date.now();
const start = end - Number(values.days) * 86_400_000;
const reads = {};
if (CF_ANALYTICS_TOKEN) {
  const readers = metricReaders({ token: CF_ANALYTICS_TOKEN, account: spec.account, bucket: BUCKET });
  for (const [name, read] of Object.entries(readers)) reads[name] = await read({ start, end }).catch((e) => void (metrics.unreadable[name] = String(e.message).slice(0, 200)));
} else metrics.unreadable.analytics = 'CF_ANALYTICS_TOKEN not set';
async function pipelineOf() {
  const { CLOUDFLARE_API_TOKEN } = readEnvFile('basin-dev.env');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${spec.account}/pipelines/v1/pipelines?name=${PIPELINE}`, { headers: { authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, `pipelines: ${response.status}`);
  const found = body.result?.find((p) => p.name === PIPELINE);
  assert.ok(found, 'The pipeline was not found by name');
  metrics.pipeline_status = found.status ?? null;
  return found;
}
const pipelineId = (await pipelineOf().catch((e) => void (metrics.unreadable.pipeline = String(e.message).slice(0, 200))))?.id ?? null;
const days = daily(reads.operator ?? [], reads.sink ?? [], reads.dropped ?? [], pipelineId);
const storedRow = reads.stored?.[0]?.max;
const stored_bytes = (storedRow?.payloadSize ?? 0) + (storedRow?.metadataSize ?? 0);
const operations = operationsByClass(reads.operations ?? []);
const busiest = days.reduce((top, d) => (d.uncompressed_bytes > (top?.uncompressed_bytes ?? -1) ? d : top), null);
const queries_gb_day = scanned / 1e9;
Object.assign(metrics, {
  days,
  stored_bytes,
  objects: storedRow?.objectCount ?? null,
  operations,
  bytes_per_record: perRecord(days),
  sql_bytes_scanned: scanned,
  dropped_total: days.reduce((n, d) => n + d.dropped + d.decode_errors, 0),
  cost: days.map((d) => dayCost(d, { stored_bytes, ...operations, days_of_operations: Number(values.days), queries_gb_day })),
  month_after_included_usd: busiest ? dayCost(busiest, { stored_bytes, ...operations, days_of_operations: Number(values.days), queries_gb_day }).month_after_included_usd : null,
});

const notComparedRows = notCompared.reduce((n, r) => n + r.rows, 0);
const record = { checked_at: new Date().toISOString(), since, settle_minutes: Number(values['settle-minutes']), summary, repositories: repos, not_compared: { repositories: notCompared.length, rows: notComparedRows, why: 'deleted, or not readable by these accounts' }, metrics };
await evidence('basin-soak', url, record, { quiet: true, dir });
console.log(JSON.stringify({ ...summary, not_compared: record.not_compared, bytes_per_record: metrics.bytes_per_record, month_after_included_usd: metrics.month_after_included_usd, unreadable: metrics.unreadable, gates: GATES }, null, 2));
// A sign-in each day would otherwise fill the account's sessions and evict a person's.
await Promise.all(sessions.map((session) => session.raw('POST', '/api/auth/logout', {}).catch(() => null)));
process.exitCode = summary.verdict === 'fail' ? 1 : summary.verdict === 'pass' ? 0 : 3;
