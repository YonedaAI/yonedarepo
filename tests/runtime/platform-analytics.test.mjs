// The Basin analytics tool: `setup` creates what is missing and nothing else, in order, and
// no credential reaches its output, even when the API echoes one. Runs against a local stand-in
// for the Cloudflare API; the real setup is a manual step (docs/runbook.md).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** Answers like the Cloudflare API from `state`, recording every write. */
async function standIn({ state, refuse }) {
  const writes = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => {
      text += chunk;
    });
    request.on('end', () => {
      const path = request.url.replace(/^\/accounts\/[0-9a-f]+/, '');
      const body = text ? JSON.parse(text) : undefined;
      const answer = (status, value) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (refuse?.(path, body)) return answer(403, { success: false, errors: [{ message: `refused ${JSON.stringify(body)} ${request.headers.authorization}` }] });
      if (request.method === 'POST') {
        writes.push({ path, body, bearer: request.headers.authorization });
        const kind = path.split('/').at(-1);
        if (state[kind]) state[kind].push({ id: `${kind}-id`, ...body });
        return answer(200, { success: true, result: { id: `${kind}-id`, ...body } });
      }
      if (path.startsWith('/r2/buckets')) return answer(200, { success: true, result: { buckets: state.buckets } });
      if (path === '/basin-catalog') return answer(200, { success: true, result: { warehouses: state.warehouses } });
      return answer(200, { success: true, result: state[path.split('/').at(-1)] });
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
