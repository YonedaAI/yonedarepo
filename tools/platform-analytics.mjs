#!/usr/bin/env node
// P4 change-log analytics on Basin for the isolated platform-dev Worker. The Worker's
// post-land derive job streams change records to stream yonedarepo_platform_dev_changes_v1
// (schema: cloudflare/basin/change-log.schema.json); this script creates the Iceberg sink
// and pipeline once, and answers questions with Basin SQL. Events are at least once, so
// every query dedupes on event_key first.
// Credentials: BASIN_TOKEN (R2 "Admin Read & Write" account API token: Basin Catalog write
// for the sink, Basin SQL read for queries), loaded from env and never printed. `setup`
// also uses the wrangler OAuth session for the Pipelines API.
// Usage: node tools/platform-analytics.mjs setup
//        node tools/platform-analytics.mjs <landed SHA | hourly | rates | n9 | status | all> [--since ISO]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'f011d0ee02b23cad26b4b38151b204ad';
const BUCKET = 'yonedarepo-platform-dev-analytics';
const STREAM = 'yonedarepo_platform_dev_changes_v1';
const SINK = 'yonedarepo_platform_dev_changes_sink_v1';
const PIPELINE = 'yonedarepo_platform_dev_changes_pipeline_v1';
const [NAMESPACE, TABLE] = ['platform', 'changes_v1'];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { since: { type: 'string', default: new Date(Date.now() - 7 * 86_400_000).toISOString() } },
});
const token = process.env.BASIN_TOKEN ?? process.env.WRANGLER_BASIN_SQL_AUTH_TOKEN;
assert.ok(token, 'Set BASIN_TOKEN (R2 Admin Read & Write account API token)');
const since = new Date(values.since).toISOString();

async function setup() {
  const oauth = JSON.parse(execFileSync('npx', ['wrangler', 'auth', 'token', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pipelines/v1`;
  const api = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${oauth.token}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const value = await response.json();
    assert.ok(value.success, `${path}: ${JSON.stringify(value.errors)}`);
    return value.result;
  };
  const sinks = await api('/sinks');
  if (!sinks.some((s) => s.name === SINK))
    await api('/sinks', {
      name: SINK,
      type: 'r2_data_catalog',
      format: { type: 'parquet', compression: 'zstd' },
      config: { bucket: BUCKET, namespace: NAMESPACE, table_name: TABLE, token, rolling_policy: { interval_seconds: 60 } },
    });
  const pipelines = await api('/pipelines');
  if (!pipelines.some((p) => p.name === PIPELINE))
    await api('/pipelines', { name: PIPELINE, sql: `INSERT INTO ${SINK} SELECT * FROM ${STREAM}` });
  const listed = (await api('/pipelines')).find((p) => p.name === PIPELINE);
  return { sink: SINK, pipeline: PIPELINE, status: listed?.status ?? null, failure_reason: listed?.failure_reason ?? null };
}

async function sql(query) {
  const response = await fetch(`https://api.sql.cloudflarestorage.com/api/v1/accounts/${ACCOUNT}/basin-sql/query/${BUCKET}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const value = await response.json().catch(() => ({}));
  assert.ok(response.ok && value.success !== false, `Basin SQL ${response.status}: ${JSON.stringify(value.errors ?? value)}`);
  return { rows: value.result?.rows ?? value.result, metrics: value.result?.metrics };
}

// One row per event_key (duplicate deliveries are identical apart from __ingest_ts).
// Accepted changes: a landed version that was not an octopus batch, or a commit a batch landed.
const changes = `WITH changes AS (
  SELECT DISTINCT event_key, event, repo, version, ticket, ref, "commit", kind, actor, actor_kind,
    paths_changed, read_set_size, base_lag, merged_landings, checks_passed, checks_failed,
    check_runs, check_run_ms, repairs, land_latency_ms, queue_wait_ms, error_code, occurred_at
  FROM ${NAMESPACE}.${TABLE} WHERE occurred_at >= '${since}'
), accepted AS (
  SELECT * FROM changes WHERE event = 'merged' OR (event = 'land' AND merged_landings = 0)
)`;
const SHA = /^[0-9a-f]{40}$/;
const queries = {
  // S15 across repositories: when (and where) did commit X land?
  landed: (sha) => {
    assert.ok(SHA.test(sha ?? ''), 'landed needs a 40-hex commit id');
    return `${changes} SELECT repo, ref, version, event, kind, actor, occurred_at, land_latency_ms, queue_wait_ms
      FROM changes WHERE "commit" = '${sha}' AND event IN ('land', 'merged') ORDER BY occurred_at LIMIT 50`;
  },
  hourly: () => `${changes} SELECT date_trunc('hour', occurred_at) AS hour, COUNT(*) AS accepted_changes,
      COUNT(DISTINCT repo) AS repos, AVG(land_latency_ms) AS avg_land_latency_ms
    FROM accepted GROUP BY date_trunc('hour', occurred_at) ORDER BY hour DESC LIMIT 168`,
  // Conflicts are refused queued landings; repairs are post-land revert proposals; base_lag
  // counts versions that landed between a writer's read and its landing.
  rates: () => `${changes} SELECT repo,
      SUM(CASE WHEN event <> 'refused' AND NOT (event = 'land' AND merged_landings > 0) THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN event = 'refused' THEN 1 ELSE 0 END) AS refused,
      SUM(CASE WHEN event = 'refused' THEN 1.0 ELSE 0.0 END) / COUNT(*) AS conflict_rate,
      SUM(CASE WHEN repairs > 0 THEN 1.0 ELSE 0.0 END) / NULLIF(SUM(CASE WHEN event <> 'refused' THEN 1 ELSE 0 END), 0) AS repair_rate,
      SUM(CASE WHEN base_lag > 0 THEN 1 ELSE 0 END) AS landed_after_concurrent_writes,
      SUM(CASE WHEN event = 'land' AND merged_landings > 0 THEN 1 ELSE 0 END) AS octopus_batches
    FROM changes GROUP BY repo ORDER BY accepted DESC LIMIT 100`,
  // N9 inputs for cost per accepted change: attempts, accepted, check executor time, size.
  n9: () => `${changes} SELECT actor_kind, actor,
      SUM(CASE WHEN event = 'refused' THEN 0 WHEN event = 'land' AND merged_landings > 0 THEN 0 ELSE 1 END) AS accepted,
      SUM(CASE WHEN event = 'refused' THEN 1 ELSE 0 END) AS refused,
      SUM(COALESCE(check_runs, 0)) AS check_runs, SUM(COALESCE(check_run_ms, 0)) AS check_run_ms,
      SUM(COALESCE(paths_changed, 0)) AS paths_changed, SUM(COALESCE(repairs, 0)) AS repairs,
      approx_percentile_cont(land_latency_ms, 0.5) AS p50_land_latency_ms
    FROM changes WHERE NOT (event = 'land' AND merged_landings > 0) GROUP BY actor_kind, actor ORDER BY accepted DESC LIMIT 100`,
  status: () => `SELECT COUNT(*) AS rows_ingested, COUNT(DISTINCT event_key) AS distinct_events,
      MIN(occurred_at) AS first_event, MAX(occurred_at) AS last_event, MAX(__ingest_ts) AS last_ingest
    FROM ${NAMESPACE}.${TABLE}`,
};

const [command = 'all', arg] = positionals;
if (command === 'setup') console.log(JSON.stringify(await setup(), null, 2));
else {
  const names = command === 'all' ? ['status', 'hourly', 'rates', 'n9'] : [command];
  const out = { since };
  for (const name of names) {
    assert.ok(queries[name], `Unknown query ${name}`);
    out[name] = await sql(queries[name](arg));
  }
  console.log(JSON.stringify(out, null, 2));
}
