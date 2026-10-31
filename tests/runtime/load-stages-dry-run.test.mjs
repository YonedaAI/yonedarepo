// The load tools end to end against a stub on loopback (support/bench-stub.mjs), through the real
// bench client Worker: the only dry run they get before dev. Nothing here reaches a network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connect } from '../../tools/fanout-bench/driver.mjs';
import { manyRepo } from '../../tools/fanout-bench/manyrepo.mjs';
import { ensurePool } from '../../tools/fanout-bench/repo-pool.mjs';
import { runPlan } from '../../tools/fanout-bench/stages.mjs';
import { sustained } from '../../tools/fanout-bench/sustained.mjs';
import { startStub } from './support/bench-stub.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function bench(t, options) {
  const stub = await startStub(options);
  const dir = await mkdtemp(join(tmpdir(), 'bench-'));
  Object.assign(process.env, { YONEDA_USERNAME: 'stub', YONEDA_PASSWORD: 'stub', BENCH_KEY: 'stub-key' });
  const session = await connect(stub.url, stub.client);
  t.after(async () => {
    await stub.stop();
    await rm(dir, { recursive: true, force: true });
  });
  return { stub, session, pool: (name) => join(dir, `pool-${name}.json`) };
}
const quiet = { sample_ms: 50, settle_ms: 0, log: () => {} };

test('preflight passes on this bench client and refuses an older one', async (t) => {
  const { stub, session } = await bench(t);
  await session.preflight();
  const older = await connect(stub.url, `${stub.url}/nothing`);
  await assert.rejects(older.preflight(), /is not ready/);
});

test('2,000 batches leave this machine as 40 requests', async (t) => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/api/auth/login')) return new Response('{}', { headers: { 'set-cookie': 'session=x' } });
    const { relay } = JSON.parse(init.body);
    sent.push(relay.length);
    return Response.json({ batches: relay.map((b) => ({ repo: b.repo, results: b.writers.map(() => ({ commit: { status: 200 }, land: { status: 200 } })) })) });
  });
  const session = await connect('http://stub', 'http://client');
  const batches = Array.from({ length: 2000 }, (_, i) => ({ repo: `r${String(i).padStart(20, '0')}`, writers: [{}, {}, {}, {}, {}] }));
  const rows = await session.relayed(batches);
  assert.equal(sent.length, 40);
  assert.ok(sent.every((n) => n === 50));
  assert.equal(rows.length, 10_000);
  assert.equal(rows[9_999].repo, batches[1999].repo);
});

test('a relay the bench client refuses counts every writer it carried as failed', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => (String(url).endsWith('/api/auth/login') ? new Response('{}', { headers: { 'set-cookie': 'session=x' } }) : new Response('error code: 1102', { status: 503 })));
  const session = await connect('http://stub', 'http://client');
  const rows = await session.relayed([{ repo: 'r1', writers: [{}, {}] }, { repo: 'r2', writers: [{}] }]);
  assert.deepEqual(rows.map((r) => r.repo), ['r1', 'r1', 'r2']);
  assert.ok(rows.every((r) => r.commit.error === 'BENCH_CLIENT' && r.land === null));
  assert.match(rows[0].commit.message, /1102/);
});

test('invocations alternate between two clients, and a run can use one', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/api/auth/login')) return new Response('{}', { headers: { 'set-cookie': 'session=x' } });
    seen.push(String(url));
    return Response.json({ results: [] });
  });
  const session = await connect('http://stub', 'http://one', { client2: 'http://two' });
  assert.equal(session.clients, 2);
  await session.invoke({});
  await session.invoke({});
  session.useClients(1);
  await session.invoke({});
  await session.invoke({});
  assert.deepEqual(seen.slice(0, 2), ['http://one', 'http://two']);
  assert.deepEqual(seen.slice(2), ['http://one', 'http://one']);
  assert.throws(() => session.useClients(3), /2 bench clients/);
});

test('many repositories land through the relay and leave no token', async (t) => {
  const { stub, session, pool } = await bench(t);
  const repos = await ensurePool(session, { file: pool('m'), size: 60, prefix: 'm' });
  const result = await manyRepo(session, { ...quiet, repos, writers: 10, analytics: null, stage: '2' });
  assert.equal(result.land.ok, 600);
  assert.equal(result.commit.ok, 600);
  assert.deepEqual(result.stop, []);
  assert.equal(result.checks, null);
  assert.equal(result.summary.what_broke, null);
  assert.equal(stub.state.tokens.size, 0, 'every token revoked');
  assert.ok(result.server.summary.samples >= 2);
  assert.deepEqual(result.server.summary.unreadable, { analytics: 'CF_ANALYTICS_TOKEN not set' });
  const mutations = stub.state.calls.filter((c) => c.path.endsWith('/compaction') && c.method !== 'GET');
  assert.deepEqual(mutations, []);
});

test('the ypat_ arm writes with personal tokens and revokes them', async (t) => {
  const { stub, session, pool } = await bench(t);
  const repos = await ensurePool(session, { file: pool('p'), size: 3, prefix: 'p' });
  const result = await manyRepo(session, { ...quiet, repos, writers: 5, principals: 'pat', pats: 2, analytics: null });
  assert.equal(result.land.ok, 15);
  assert.equal(result.principals, 'pat');
  assert.equal(stub.state.pats.size, 0);
  assert.equal(stub.state.tokens.size, 0);
  const lands = stub.state.calls.filter((c) => c.path.endsWith('/land'));
  assert.ok(lands.length && lands.every((c) => c.bearer === 'ypat'));
});

test('a burst over the error rule stops, starts no checks, and names what broke', async (t) => {
  const { session, pool } = await bench(t, { landing: () => ({ code: 'INTERNAL', message: 'Durable Object is overloaded.', status: 503 }) });
  const repos = await ensurePool(session, { file: pool('s'), size: 2, prefix: 's' });
  const result = await manyRepo(session, { ...quiet, repos, writers: 5, checks: true, analytics: null });
  assert.deepEqual(result.stop, ['errors', 'p95', 'limit']);
  assert.equal(result.checks, null);
  assert.match(result.summary.what_broke, /limit: 503 INTERNAL/);
});

test('sustained load runs across repositories on saved repositories', async (t) => {
  const { stub, session, pool } = await bench(t);
  const repos = await ensurePool(session, { file: pool('u'), size: 2, prefix: 'u' });
  const result = await sustained(session, { ...quiet, repos, rates: [4], step_s: 2, per_shard: 2, segment_s: 1, arrivals: 'fixed', warmup_s: 0, analytics: null, stage: '3' });
  const [step] = result.steps;
  assert.equal(step.arrivals, 8);
  assert.equal(step.landed, 8);
  assert.deepEqual(step.stopped, null);
  assert.equal(step.ran_segments, 2);
  assert.equal(result.summary.size, '2 × 4/s, 2 s');
  assert.equal(result.summary.arm, 'tokens spread');
  assert.equal(stub.state.tokens.size, 0);
  assert.equal(stub.state.repoCount, 2, 'no repository made for the run');
});

test('a sustained run stops between segments once one breaks the rules', async (t) => {
  const { session, pool } = await bench(t, { landing: () => ({ code: 'INTERNAL', message: 'nope', status: 500 }) });
  const repos = await ensurePool(session, { file: pool('v'), size: 1, prefix: 'v' });
  const result = await sustained(session, { ...quiet, repos, rates: [4, 8], step_s: 6, per_shard: 2, segment_s: 1, lead_ms: 100, arrivals: 'fixed', warmup_s: 0, analytics: null });
  const [step] = result.steps;
  assert.equal(result.steps.length, 1, 'no higher rate after a stop');
  assert.ok(step.stopped.reasons.includes('errors'));
  assert.ok(step.ran_segments < step.segments, `ran ${step.ran_segments} of ${step.segments}`);
  assert.equal(result.knee, 4);
});

test('the runner keeps one evidence record per run and a stop ends the stage only', async (t) => {
  let lands = 0;
  const { session, pool } = await bench(t, { landing: () => (++lands > 20 ? { code: 'INTERNAL', message: 'nope', status: 500 } : null) });
  const items = [
    { stage: '2', run: 1, arm: 'tokens', repos: 2, writers: 5, clients: 1, settle_s: 0 },
    { stage: '2', run: 2, arm: 'tokens', repos: 2, writers: 5, clients: 1, settle_s: 0 },
    { stage: '2', run: 3, arm: 'tokens', repos: 2, writers: 5, clients: 1, settle_s: 0 },
    { stage: '2', run: 4, arm: 'tokens', repos: 2, writers: 5, clients: 1, settle_s: 0 },
    { stage: '3', run: 1, arm: 'one', repos: 1, rate: 1, seconds: 1, layout: 'single', segment_s: 1, clients: 1, settle_s: 0 },
  ];
  const recorded = [];
  const logged = [];
  const outcome = await runPlan(session, items, { record: async (name, result) => recorded.push([name, result]), pool, sample: false, log: (text) => logged.push(text) });
  assert.deepEqual(recorded.map(([name]) => name), ['stage2-2x5-tokens-c1', 'stage2-2x5-tokens-c1', 'stage2-2x5-tokens-c1', 'stage3-one']);
  assert.equal(outcome.done.length, 4);
  assert.match(outcome.stopped['2'], /errors/);
  assert.ok(logged.some((l) => l.startsWith('Stage 2 stopped')));
  assert.equal(outcome.stopped['3'], outcome.done[3].what_broke ?? undefined);
});

test('the runner states its cost, refuses without --yes, and refuses prod', () => {
  const run = (...args) => spawnSync(process.execPath, ['tools/platform-load-stages.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 20_000 });
  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stderr, /Plan: 33 runs, about [\d.]+ h, about [\d,]+ platform requests/);
  const refused = run();
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Nothing ran/);
  const prod = run('--url', 'https://yonedarepo-prod-platform.mlong-f01.workers.dev', '--dry-run');
  assert.notEqual(prod.status, 0);
  assert.match(prod.stderr, /dev only/);
  const few = run('--runs', '2', '--dry-run');
  assert.notEqual(few.status, 0);
  assert.match(few.stderr, /at least 3/);
});
