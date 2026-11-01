#!/usr/bin/env node
// Change-log analytics on Basin for one environment (docs/runbook.md, "Basin analytics"). The
// platform Worker's post-land derive job streams change records to a stream with the schema
// in cloudflare/basin/change-log.schema.json. `setup` creates what xtask does not know: the
// sink bucket and its catalog, the stream, the Iceberg sink and the pipeline, each only if
// missing. The other commands answer questions with Basin SQL. Events are at least once and
// a stream can have gaps, so every query dedupes on event_key first and counts are a floor.
// Credentials: ~/.config/yonedarepo/basin.env, or the environment over it. BASIN_TOKEN is
// an R2 "Admin Read & Write" account API token: Basin Catalog write for the sink, Basin SQL
// read for queries. `setup` also needs the Cloudflare API: CLOUDFLARE_API_TOKEN, else the
// wrangler login, holding the PERMISSIONS below. No credential is printed: all output goes
// through `scrub`. A dry run makes no network call, so it proves names, not access.
// Usage: node tools/platform-analytics.mjs setup [--env dev|prod] [--dry-run]
//        node tools/platform-analytics.mjs <landed SHA | hourly | daily | rates | n9 | status | all>
//             [--env dev|prod] [--since ISO] [--dry-run]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { LANDING } from './basin-soak/landing.mjs';

const repoFile = (path) => new URL(`../${path}`, import.meta.url);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: 'string', default: 'dev' },
    since: { type: 'string', default: new Date(Date.now() - 7 * 86_400_000).toISOString() },
    'dry-run': { type: 'boolean', default: false },
  },
});
assert.ok(['dev', 'prod'].includes(values.env), '--env must be dev or prod');
const dryRun = values['dry-run'];
const since = new Date(values.since).toISOString();

const ACCOUNT = JSON.parse(readFileSync(repoFile(`infra/envs/${values.env}.json`), 'utf8')).account_id;
const API = process.env.ANALYTICS_API_BASE ?? 'https://api.cloudflare.com/client/v4';
// Not the retired platform-dev names: `infra prune` deletes a bucket on the retired list.
// Stream, sink and pipeline names take underscores; bucket names take hyphens.
const BUCKET = `yonedarepo-${values.env}-change-log`;
const STREAM = `yonedarepo_${values.env}_changes_v1`;
const SINK = `yonedarepo_${values.env}_changes_sink_v1`;
const PIPELINE = `yonedarepo_${values.env}_changes_pipeline_v1`;
const [NAMESPACE, TABLE] = ['platform', 'changes_v1'];
/** Seconds a sink buffers before it writes a file: more means fewer small files. */
const ROLL_SECONDS = values.env === 'prod' ? 300 : 60;
/** Account limit on each of streams, sinks and pipelines. */
const MAX_PER_ACCOUNT = 20;
/** What the Cloudflare API token needs, by route. */
const PERMISSIONS = [
  ['/pipelines/', 'Pipelines Write'],
  ['/basin-catalog', 'Workers R2 Data Catalog Write'],
  ['/r2/', 'Workers R2 Storage Write'],
];

const CREDENTIALS_FILE = join(homedir(), '.config/yonedarepo/basin.env');
function envFile(path) {
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, 'utf8').split('\n');
  const pairs = lines.map((line) => line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/)).filter(Boolean);
  return Object.fromEntries(pairs.map(([, key, value]) => [key, value.trim().replace(/^(['"])(.*)\1$/, '$2')]));
}
const stored = envFile(CREDENTIALS_FILE);
const secrets = new Set(Object.values(stored).filter(Boolean));
const remember = (secret) => {
  if (secret) secrets.add(secret);
  return secret;
};
const token = remember(
  process.env.BASIN_TOKEN ?? stored.BASIN_TOKEN ?? process.env.WRANGLER_BASIN_SQL_AUTH_TOKEN ?? stored.WRANGLER_BASIN_SQL_AUTH_TOKEN,
);
const scrub = (text) => [...secrets].reduce((out, secret) => out.replaceAll(secret, '[redacted]'), String(text));
const requireToken = () => assert.ok(token, `Set BASIN_TOKEN (R2 Admin Read & Write account API token) in ${CREDENTIALS_FILE}`);

function controlToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return remember(process.env.CLOUDFLARE_API_TOKEN);
  const login = execFileSync('npx', ['wrangler', 'auth', 'token', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return remember(JSON.parse(login).token);
}

const schema = () => JSON.parse(readFileSync(repoFile('cloudflare/basin/change-log.schema.json'), 'utf8'));
const insert = `INSERT INTO ${SINK} SELECT * FROM ${STREAM}`;

/** The resources `setup` makes sure of, in order; nothing here needs a credential. */
const planned = () => ({
  env: values.env,
  dry_run: true,
  would_ensure: { bucket: BUCKET, catalog: BUCKET, stream: STREAM, sink: SINK, pipeline: PIPELINE },
  table: `${NAMESPACE}.${TABLE}`,
  stream_fields: schema().fields.length,
  roll_seconds: ROLL_SECONDS,
  sql: insert,
  credentials: { file: existsSync(CREDENTIALS_FILE), BASIN_TOKEN: token ? 'present' : 'missing' },
});

async function setup() {
  requireToken();
  const bearer = controlToken();
  const request = async (path, body) => {
    const response = await fetch(`${API}/accounts/${ACCOUNT}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({}));
    const missing = PERMISSIONS.find(([route]) => path.startsWith(route))?.[1];
    const hint = response.status === 403 && missing ? ` (the Cloudflare API token needs ${missing})` : '';
    assert.ok(response.ok && value.success !== false, `${path}: ${response.status} ${JSON.stringify(value.errors ?? [])}${hint}`);
    return value;
  };
  const api = async (path, body) => (await request(path, body)).result;
  const ensure = async (path, name, body) => {
    // Lists are paged, so ask by name (a substring filter) and count from the total.
    const found = (await api(`${path}?name=${name}`)).find((item) => item.name === name);
    if (found) return { ...found, created: false };
    const { result_info: listed } = await request(`${path}?per_page=1`);
    assert.ok((listed?.total_count ?? 0) < MAX_PER_ACCOUNT, `${path}: the account is at its limit of ${MAX_PER_ACCOUNT}`);
    return { ...(await api(path, body)), created: true };
  };

  const base = '/pipelines/v1';
  // Reads first: a token missing a permission stops here, before anything exists.
  const { warehouses } = await api('/basin-catalog');
  await api(`${base}/streams?per_page=1`);
  const { buckets } = await api(`/r2/buckets?name_contains=${BUCKET}`);
  const bucketCreated = !buckets.some((b) => b.name === BUCKET);
  if (bucketCreated) await api('/r2/buckets', { name: BUCKET });
  const catalogEnabled = !warehouses.some((w) => w.bucket === BUCKET && w.status === 'active');
  if (catalogEnabled) await api(`/basin-catalog/${BUCKET}/enable`, {});

  // Worker binding only: nothing else may write to this stream. Everything here is
  // immutable once created, so a schema change is a new `_v2` stream. Events that miss the
  // schema are dropped in silence, and neither format default is documented: both are set.
  const stream = await ensure(`${base}/streams`, STREAM, {
    name: STREAM,
    format: { type: 'json', timestamp_format: 'rfc3339', unstructured: false },
    schema: { fields: schema().fields },
    http: { enabled: false, authentication: true },
    worker_binding: { enabled: true },
  });
  const sink = await ensure(`${base}/sinks`, SINK, {
    name: SINK,
    type: 'r2_data_catalog',
    format: { type: 'parquet', compression: 'zstd' },
    config: { account_id: ACCOUNT, bucket: BUCKET, namespace: NAMESPACE, table_name: TABLE, token, rolling_policy: { interval_seconds: ROLL_SECONDS } },
  });
  const pipeline = await ensure(`${base}/pipelines`, PIPELINE, { name: PIPELINE, sql: insert });
  // The list has no failure_reason: only a pipeline's own GET does.
  const running = await api(`${base}/pipelines/${pipeline.id}`);
  return {
    env: values.env,
    created: { bucket: bucketCreated, catalog: catalogEnabled, stream: stream.created, sink: sink.created, pipeline: pipeline.created },
    pipeline_status: running.status ?? null,
    failure_reason: running.failure_reason ?? null,
    binding: { pipelines: [{ binding: 'CHANGELOG', stream: stream.id }] },
  };
}

async function sql(query) {
  if (dryRun) return { query };
  requireToken();
  const response = await fetch(`https://api.sql.cloudflarestorage.com/api/v1/accounts/${ACCOUNT}/basin-sql/query/${BUCKET}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const value = await response.json().catch(() => ({}));
  assert.ok(response.ok && value.success !== false, `Basin SQL ${response.status}: ${JSON.stringify(value.errors ?? value)}`);
  return { rows: value.result?.rows ?? value.result, metrics: value.result?.metrics };
}

// One row per event_key (re-sends repeat the same record, so any value per key will do).
// GROUP BY, not DISTINCT ON: Basin SQL rejects DISTINCT ON under a second aggregate once
// the table spans several files.
// actor_kind 'test' rows are the labelled probe events sent to verify the pipeline.
// Rows do not name the repository's base branch, so a landing (LANDING) on any branch counts.
const changes = `WITH changes AS (
  SELECT event_key,
    MAX(event) AS event,
    MAX(repo) AS repo,
    MAX(version) AS version,
    MAX(ticket) AS ticket,
    MAX(ref) AS ref,
    MAX("commit") AS "commit",
    MAX(kind) AS kind,
    MAX(actor) AS actor,
    MAX(actor_kind) AS actor_kind,
    MAX(paths_changed) AS paths_changed,
    MAX(read_set_size) AS read_set_size,
    MAX(base_lag) AS base_lag,
    MAX(merged_landings) AS merged_landings,
    MAX(checks_passed) AS checks_passed,
    MAX(checks_failed) AS checks_failed,
    MAX(check_runs) AS check_runs,
    MAX(check_run_ms) AS check_run_ms,
    MAX(repairs) AS repairs,
    MAX(land_latency_ms) AS land_latency_ms,
    MAX(queue_wait_ms) AS queue_wait_ms,
    MAX(error_code) AS error_code,
    MAX(occurred_at) AS occurred_at
  FROM ${NAMESPACE}.${TABLE} WHERE occurred_at >= '${since}' AND actor_kind <> 'test' GROUP BY event_key
), outcomes AS (
  SELECT * FROM changes WHERE event = 'refused' OR ${LANDING}
), accepted AS (
  SELECT * FROM outcomes WHERE event <> 'refused'
)`;
const rollup = (unit, limit) => `${changes} SELECT date_trunc('${unit}', occurred_at) AS ${unit}, COUNT(*) AS accepted_changes,
      COUNT(DISTINCT repo) AS repos, AVG(land_latency_ms) AS avg_land_latency_ms
    FROM accepted GROUP BY date_trunc('${unit}', occurred_at) ORDER BY ${unit} DESC LIMIT ${limit}`;
const SHA = /^[0-9a-f]{40}$/;
const queries = {
  // S15 across repositories: when (and where) did commit X land?
  landed: (sha) => {
    assert.ok(SHA.test(sha ?? ''), 'landed needs a 40-hex commit id');
    return `${changes} SELECT repo, ref, version, event, kind, actor, occurred_at, land_latency_ms, queue_wait_ms
      FROM changes WHERE "commit" = '${sha}' AND event IN ('land', 'merged') ORDER BY occurred_at LIMIT 50`;
  },
  hourly: () => rollup('hour', 168),
  daily: () => rollup('day', 90),
  // Conflicts are refused queued landings; repairs are post-land revert proposals; base_lag
  // counts versions that landed between a writer's read and its landing.
  rates: () => `${changes} SELECT repo,
      SUM(CASE WHEN ${LANDING} THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN event = 'refused' THEN 1 ELSE 0 END) AS refused,
      SUM(CASE WHEN event = 'refused' THEN 1.0 ELSE 0.0 END) / NULLIF(SUM(CASE WHEN event = 'refused' OR ${LANDING} THEN 1 ELSE 0 END), 0) AS conflict_rate,
      SUM(CASE WHEN ${LANDING} AND repairs > 0 THEN 1.0 ELSE 0.0 END) / NULLIF(SUM(CASE WHEN ${LANDING} THEN 1 ELSE 0 END), 0) AS repair_rate,
      SUM(CASE WHEN ${LANDING} AND base_lag > 0 THEN 1 ELSE 0 END) AS landed_after_concurrent_writes,
      SUM(CASE WHEN event = 'land' AND merged_landings > 0 THEN 1 ELSE 0 END) AS octopus_batches
    FROM changes GROUP BY repo ORDER BY accepted DESC LIMIT 100`,
  // N9 inputs for cost per accepted change: attempts, accepted, check executor time, size.
  n9: () => `${changes} SELECT actor_kind, actor,
      SUM(CASE WHEN event = 'refused' THEN 0 ELSE 1 END) AS accepted,
      SUM(CASE WHEN event = 'refused' THEN 1 ELSE 0 END) AS refused,
      SUM(COALESCE(check_runs, 0)) AS check_runs, SUM(COALESCE(check_run_ms, 0)) AS check_run_ms,
      SUM(COALESCE(paths_changed, 0)) AS paths_changed, SUM(COALESCE(repairs, 0)) AS repairs,
      approx_percentile_cont(land_latency_ms, 0.5) AS p50_land_latency_ms
    FROM outcomes GROUP BY actor_kind, actor ORDER BY accepted DESC LIMIT 100`,
  status: () => `SELECT COUNT(*) AS rows_ingested, COUNT(DISTINCT event_key) AS distinct_events,
      MIN(occurred_at) AS first_event, MAX(occurred_at) AS last_event, MAX(__ingest_ts) AS last_ingest
    FROM ${NAMESPACE}.${TABLE}`,
};

async function main() {
  const [command = 'all', arg] = positionals;
  if (command === 'setup') return dryRun ? planned() : setup();
  const names = command === 'all' ? ['status', 'hourly', 'daily', 'rates', 'n9'] : [command];
  const out = { env: values.env, since };
  for (const name of names) {
    assert.ok(queries[name], `Unknown query ${name}`);
    out[name] = await sql(queries[name](arg));
  }
  return out;
}

try {
  console.log(scrub(JSON.stringify(await main(), null, 2)));
} catch (error) {
  console.error(scrub(error?.message ?? error));
  process.exitCode = 1;
}
