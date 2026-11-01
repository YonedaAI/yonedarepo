// The Basin analytics tool: `setup` creates what is missing and nothing else, in order, and
// no credential reaches its output, even when the API echoes one. Runs against a local stand-in
// for the Cloudflare API; the real setup is a manual step (docs/runbook.md).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const tool = new URL('../../tools/platform-analytics.mjs', import.meta.url).pathname;
const SECRET = 'sentinel-basin-token-0123456789';
const OTHER = 'sentinel-r2-key-9876543210';
const CONTROL = 'sentinel-control-token-5555';

function home(contents = `BASIN_TOKEN=${SECRET}\nR2_SECRET_ACCESS_KEY="${OTHER}"\n`) {
  const dir = mkdtempSync(join(tmpdir(), 'analytics-home-'));
  if (contents !== null) {
    mkdirSync(join(dir, '.config/yonedarepo'), { recursive: true });
    writeFileSync(join(dir, '.config/yonedarepo/basin.env'), contents);
  }
  return dir;
}

function run(args, env) {
  const { BASIN_TOKEN, WRANGLER_BASIN_SQL_AUTH_TOKEN, CLOUDFLARE_API_TOKEN, ...inherited } = process.env;
  return new Promise((resolve) => {
    execFile('node', [tool, ...args], { env: { ...inherited, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

/** Answers like the Cloudflare API from `state`, recording every write. Lists page at 10 with
 * a `name` substring filter, and only a single pipeline's GET has `failure_reason`. */
async function standIn({ state, refuse }) {
  const writes = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => {
      text += chunk;
    });
    request.on('end', () => {
      const url = new URL(request.url, 'http://stand-in');
      const path = url.pathname.replace(/^\/client\/v4/, '').replace(/^\/accounts\/[0-9a-f]+/, '');
      const body = text ? JSON.parse(text) : undefined;
      const answer = (status, value) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (refuse?.(path, body, request.method)) return answer(403, { success: false, errors: [{ message: `refused ${JSON.stringify(body)} ${request.headers.authorization}` }] });
      if (request.method === 'POST') {
        writes.push({ path, body, bearer: request.headers.authorization });
        const kind = path.split('/').at(-1);
        if (state[kind]) state[kind].push({ id: `${kind}-id`, ...body });
        return answer(200, { success: true, result: { id: `${kind}-id`, ...body } });
      }
      if (path.startsWith('/r2/buckets')) return answer(200, { success: true, result: { buckets: state.buckets } });
      if (path === '/basin-catalog') return answer(200, { success: true, result: { warehouses: state.warehouses } });
      const one = /^\/pipelines\/v1\/pipelines\/(.+)$/.exec(path);
      if (one) return answer(200, { success: true, result: { ...state.pipelines.find((p) => p.id === one[1]), status: 'running', failure_reason: state.failure_reason ?? null } });
      const name = url.searchParams.get('name') ?? '';
      const matching = state[path.split('/').at(-1)].filter((item) => item.name.includes(name));
      const perPage = Number(url.searchParams.get('per_page') ?? 10);
      const result = matching.slice(0, perPage);
      return answer(200, { success: true, result, result_info: { count: result.length, page: 1, per_page: perPage, total_count: matching.length } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { writes, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const empty = () => ({ buckets: [], warehouses: [], streams: [], sinks: [], pipelines: [] });
const clean = (output) => {
  for (const secret of [SECRET, OTHER, CONTROL]) {
    assert.ok(!output.stdout.includes(secret), 'stdout carries a credential');
    assert.ok(!output.stderr.includes(secret), 'stderr carries a credential');
  }
};

test('a dry run needs no network or credential and names resources that are not retired', async () => {
  const dir = home();
  const missing = home(null);
  try {
    const output = await run(['setup', '--dry-run'], { HOME: dir, ANALYTICS_API_BASE: 'http://127.0.0.1:1' });
    assert.equal(output.code, 0, output.stderr);
    clean(output);
    const plan = JSON.parse(output.stdout);
    assert.equal(plan.dry_run, true);
    assert.equal(plan.credentials.BASIN_TOKEN, 'present');
    assert.equal(plan.stream_fields, JSON.parse(readFileSync(new URL('../../cloudflare/basin/change-log.schema.json', import.meta.url))).fields.length);
    const spec = JSON.parse(readFileSync(new URL('../../infra/envs/dev.json', import.meta.url)));
    assert.equal(plan.would_ensure.bucket, 'yonedarepo-dev-change-log');
    assert.ok(!spec.retired.r2.includes(plan.would_ensure.bucket), 'infra prune would delete it');
    assert.ok(!plan.would_ensure.stream.includes('platform_dev'));

    const prod = JSON.parse((await run(['setup', '--dry-run', '--env', 'prod'], { HOME: dir })).stdout);
    assert.equal(prod.would_ensure.stream, 'yonedarepo_prod_changes_v1');

    const bare = await run(['setup', '--dry-run'], { HOME: missing });
    assert.equal(JSON.parse(bare.stdout).credentials.BASIN_TOKEN, 'missing');
  } finally {
    rmSync(dir, { recursive: true });
    rmSync(missing, { recursive: true });
  }
});

test('setup creates the bucket, catalog, stream, sink and pipeline in order, once', async () => {
  const dir = home();
  const state = empty();
  const api = await standIn({ state });
  try {
    const env = { HOME: dir, ANALYTICS_API_BASE: api.base, CLOUDFLARE_API_TOKEN: CONTROL };
    const first = await run(['setup'], env);
    assert.equal(first.code, 0, first.stderr);
    clean(first);
    assert.deepEqual(
      api.writes.map((w) => w.path),
      ['/r2/buckets', '/basin-catalog/yonedarepo-dev-change-log/enable', '/pipelines/v1/streams', '/pipelines/v1/sinks', '/pipelines/v1/pipelines'],
    );
    assert.ok(api.writes.every((w) => w.bearer === `Bearer ${CONTROL}`));
    const [, , stream, sink, pipeline] = api.writes.map((w) => w.body);
    assert.deepEqual(stream.worker_binding, { enabled: true });
    assert.equal(stream.http.enabled, false);
    // Neither default is documented, and a mismatch drops every event in silence.
    assert.deepEqual(stream.format, { type: 'json', timestamp_format: 'rfc3339', unstructured: false });
    assert.ok(stream.schema.fields.some((f) => f.name === 'queued_by'));
    assert.equal(sink.config.token, SECRET, 'the catalog token goes to the sink, and only there');
    assert.equal(pipeline.sql, 'INSERT INTO yonedarepo_dev_changes_sink_v1 SELECT * FROM yonedarepo_dev_changes_v1');
    assert.deepEqual(JSON.parse(first.stdout).binding, { pipelines: [{ binding: 'CHANGELOG', stream: 'streams-id' }] });

    // A second run finds them all and writes nothing.
    state.buckets.push({ name: 'yonedarepo-dev-change-log' });
    state.warehouses.push({ bucket: 'yonedarepo-dev-change-log', status: 'active' });
    const again = await run(['setup'], env);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(api.writes.length, 5);
    assert.deepEqual(JSON.parse(again.stdout).created, { bucket: false, catalog: false, stream: false, sink: false, pipeline: false });
  } finally {
    api.close();
    rmSync(dir, { recursive: true });
  }
});

test('an API error that echoes a credential is printed without it', async () => {
  const dir = home();
  const refused = await standIn({ state: empty(), refuse: (path, body) => path === '/pipelines/v1/sinks' && body !== undefined });
  try {
    const output = await run(['setup'], { HOME: dir, ANALYTICS_API_BASE: refused.base, CLOUDFLARE_API_TOKEN: CONTROL });
    assert.notEqual(output.code, 0);
    clean(output);
    assert.match(output.stderr, /\[redacted\]/);
  } finally {
    refused.close();
    rmSync(dir, { recursive: true });
  }
});

test('stops at the account limit rather than asking for a twenty-first', async () => {
  const dir = home();
  const state = { ...empty(), streams: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, name: `other_${i}` })) };
  const api = await standIn({ state });
  try {
    const output = await run(['setup'], { HOME: dir, ANALYTICS_API_BASE: api.base, CLOUDFLARE_API_TOKEN: CONTROL });
    assert.notEqual(output.code, 0);
    assert.match(output.stderr, /limit of 20/);
    assert.ok(!api.writes.some((w) => w.path === '/pipelines/v1/streams'));
  } finally {
    api.close();
    rmSync(dir, { recursive: true });
  }
});

test('a stream past the first page of the listing is found, not created twice', async () => {
  const dir = home();
  const state = empty();
  state.streams = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `other_${i}` }));
  state.streams.push({ id: 'ours', name: 'yonedarepo_dev_changes_v1' });
  const api = await standIn({ state });
  try {
    const output = await run(['setup'], { HOME: dir, ANALYTICS_API_BASE: api.base, CLOUDFLARE_API_TOKEN: CONTROL });
    assert.equal(output.code, 0, output.stderr);
    assert.ok(!api.writes.some((w) => w.path === '/pipelines/v1/streams'), 'it asked for a second stream');
    assert.deepEqual(JSON.parse(output.stdout).binding, { pipelines: [{ binding: 'CHANGELOG', stream: 'ours' }] });
  } finally {
    api.close();
    rmSync(dir, { recursive: true });
  }
});

test('a pipeline that failed says why: only its own GET carries the reason', async () => {
  const dir = home();
  const state = { ...empty(), failure_reason: 'bucket not found' };
  const api = await standIn({ state });
  try {
    const output = await run(['setup'], { HOME: dir, ANALYTICS_API_BASE: api.base, CLOUDFLARE_API_TOKEN: CONTROL });
    assert.equal(output.code, 0, output.stderr);
    assert.equal(JSON.parse(output.stdout).failure_reason, 'bucket not found');
  } finally {
    api.close();
    rmSync(dir, { recursive: true });
  }
});

for (const [route, permission] of [
  ['/pipelines/', 'Pipelines Write'],
  ['/basin-catalog', 'Workers R2 Data Catalog Write'],
]) {
  test(`a token without ${permission} stops before anything exists, and says so`, async () => {
    const dir = home();
    const api = await standIn({ state: empty(), refuse: (path) => path.startsWith(route) });
    try {
      const output = await run(['setup'], { HOME: dir, ANALYTICS_API_BASE: api.base, CLOUDFLARE_API_TOKEN: CONTROL });
      assert.notEqual(output.code, 0);
      clean(output);
      assert.ok(output.stderr.includes(permission), output.stderr);
      assert.deepEqual(api.writes, [], 'a half-made setup');
    } finally {
      api.close();
      rmSync(dir, { recursive: true });
    }
  });
}

test('the stream reserves the credential columns as optional: a stream cannot change later', () => {
  const { fields } = JSON.parse(readFileSync(new URL('../../cloudflare/basin/change-log.schema.json', import.meta.url)));
  for (const name of ['credential_id', 'credential_kind']) {
    assert.deepEqual(fields.find((f) => f.name === name), { name, type: 'string', required: false });
  }
});

/** The tool's own SQL, printed by a dry run, over `rows` in SQLite. SQLite is not Basin SQL:
 * this proves what the queries count, not that Basin accepts them. */
async function counted(name, rows) {
  const dir = home(null);
  try {
    const printed = await run([name, '--dry-run', '--since', '2026-01-01T00:00:00Z'], { HOME: dir });
    assert.equal(printed.code, 0, printed.stderr);
    const db = new DatabaseSync(':memory:');
    db.exec(`ATTACH ':memory:' AS platform`);
    db.exec(`CREATE TABLE platform.changes_v1(event_key, event, repo, version, ticket, ref, "commit", kind, actor, actor_kind, paths_changed,
      read_set_size, base_lag, merged_landings, checks_passed, checks_failed, check_runs, check_run_ms, repairs, land_latency_ms, queue_wait_ms,
      error_code, occurred_at, __ingest_ts)`);
    const lengths = { hour: 13, day: 10 };
    db.function('date_trunc', (unit, at) => at.slice(0, lengths[unit]));
    db.aggregate('approx_percentile_cont', { start: null, step: (_, value, _fraction) => value, result: (value) => value });
    const insert = db.prepare(
      'INSERT INTO platform.changes_v1(event_key, event, repo, version, ref, kind, actor, actor_kind, merged_landings, land_latency_ms, repairs, occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const r of rows) {
      insert.run(r.key, r.event, r.repo ?? 'r1', r.version ?? null, 'refs/heads/main', r.kind ?? null, 'user:a', r.actor_kind ?? 'user', r.merged ?? null, r.latency ?? 10, r.repairs ?? 0, r.at ?? '2026-02-01T10:30:00.000Z');
    }
    const answer = db.prepare(JSON.parse(printed.stdout)[name].query).all();
    db.close();
    return answer;
  } finally {
    rmSync(dir, { recursive: true });
  }
}

const log = [
  { key: 'r1:v1', event: 'land', kind: 'commit', merged: 0, version: 1 },
  { key: 'r1:v2', event: 'land', kind: 'merge', merged: 0, version: 2 },
  { key: 'r1:v3', event: 'land', kind: 'revert', merged: 0, version: 3 },
  { key: 'r1:v4', event: 'land', kind: 'changeset', merged: 0, version: 4, repairs: 1 },
  // Re-sent: at least once, and the same key counts once.
  { key: 'r1:v4', event: 'land', kind: 'changeset', merged: 0, version: 4, repairs: 1 },
  // Not landings: nothing changed by a writer.
  { key: 'r1:v5', event: 'land', kind: 'import', merged: 0, version: 5 },
  { key: 'r1:v6', event: 'land', kind: 'ref_move', merged: 0, version: 6 },
  { key: 'r1:v7', event: 'land', kind: 'ref_delete', merged: 0, version: 7 },
  // A batch counts its two commits, not itself.
  { key: 'r1:v8', event: 'land', kind: 'merge', merged: 2, version: 8 },
  { key: 'r1:v8:a', event: 'merged', version: 8 },
  { key: 'r1:v8:b', event: 'merged', version: 8 },
  { key: 'r1:t1', event: 'refused' },
  { key: 'r1:v9', event: 'land', kind: 'commit', merged: 0, version: 9, actor_kind: 'test' },
  // Next day, another repository.
  { key: 'r2:v1', event: 'land', kind: 'commit', merged: 0, version: 1, repo: 'r2', at: '2026-02-02T03:00:00.000Z' },
  { key: 'r2:v2', event: 'land', kind: 'import', merged: 0, version: 2, repo: 'r2', at: '2026-02-02T03:00:00.000Z' },
];

test('the rollups count landings: no imports, ref moves, ref deletes, batches, refusals or probes', async () => {
  assert.deepEqual(
    (await counted('hourly', log)).map((row) => [row.hour, row.accepted_changes, row.repos]),
    [['2026-02-02T03', 1, 1], ['2026-02-01T10', 6, 1]],
  );
});

test('daily rolls up by day', async () => {
  assert.deepEqual(
    (await counted('daily', log)).map((row) => [row.day, row.accepted_changes, row.repos]),
    [['2026-02-02', 1, 1], ['2026-02-01', 6, 1]],
  );
});

test('rates are of landings and refusals alone', async () => {
  const [one, two] = await counted('rates', log);
  assert.deepEqual([one.repo, one.accepted, one.refused, one.octopus_batches], ['r1', 6, 1, 1]);
  assert.equal(one.conflict_rate, 1 / 7);
  assert.equal(one.repair_rate, 1 / 6);
  assert.deepEqual([two.repo, two.accepted, two.refused], ['r2', 1, 0]);
});

test('n9 counts accepted changes per actor the same way', async () => {
  assert.deepEqual((await counted('n9', log)).map((row) => [row.actor, row.accepted, row.refused]), [['user:a', 7, 1]]);
});

test('setup without a token stops before any call, and queries print their SQL on a dry run', async () => {
  const dir = home(null);
  try {
    const output = await run(['setup'], { HOME: dir, ANALYTICS_API_BASE: 'http://127.0.0.1:1', CLOUDFLARE_API_TOKEN: CONTROL });
    assert.notEqual(output.code, 0);
    assert.match(output.stderr, /Set BASIN_TOKEN/);
    const query = await run(['status', '--dry-run'], { HOME: dir });
    assert.equal(query.code, 0, query.stderr);
    assert.match(JSON.parse(query.stdout).status.query, /platform\.changes_v1/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
