// Load test stage 6's pure parts and its run against stand-ins: what it plans, what stops it, how
// the limiters are judged and what its tables say. Nothing here reaches a network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { burstRequests, burstStops, DEFAULTS, describeDistance, estimateDistance, limitHeld, planDistance, tally } from '../../tools/fanout-bench/distance-plan.mjs';
import { burstTable, edgeTable, limitTable, renderDistance, replaceDistance, spread } from '../../tools/fanout-bench/distance-results.mjs';
import { flood, limitsBoth, runDistance } from '../../tools/fanout-bench/distance.mjs';
import { BENCH_VERSION } from '../../tools/fanout-bench/relay.js';
import { REGION_VERSION } from '../../tools/fanout-bench/region-steps.js';
import worker from '../../tools/fanout-bench/region-worker.js';
import { delay, edges } from '../../tools/fanout-bench/stats.mjs';

const tool = fileURLToPath(new URL('../../tools/platform-distance-bench.mjs', import.meta.url));
const REPO = `r${'a'.repeat(20)}`;
const post = (body, key = 'k') => new Request('https://client.test/', { method: 'POST', headers: { 'x-bench-key': key }, body: JSON.stringify(body) });
const answer = (status) => new Response('{}', { status, headers: { 'server-timing': 'total;dur=40', 'cf-ray': 'abc-FRA' } });

test('the plan runs every size from every client, three times, and counts its requests', () => {
  const items = planDistance(DEFAULTS);
  assert.equal(items.filter((i) => i.kind === 'burst').length, 18);
  assert.equal(items.filter((i) => i.kind === 'limits').length, 9);
  assert.equal(items.filter((i) => i.kind === 'limits-both').length, 3);
  const estimate = estimateDistance(items);
  assert.equal(estimate.requests, 9 * burstRequests(100) + 9 * burstRequests(1000) + 12 * 400);
  assert.match(describeDistance(estimate), /No new Worker/);
  assert.equal(planDistance({ ...DEFAULTS, clients: ['na'] }).filter((i) => i.kind === 'limits-both').length, 0);
});

test('a dry run prints the plan and nothing runs without --yes', () => {
  const dry = spawnSync('node', [tool, '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stderr, /18 bursts and 12 limiter rounds/);
  const refused = spawnSync('node', [tool], { encoding: 'utf8' });
  assert.equal(refused.status, 2);
  const prod = spawnSync('node', [tool, '--dry-run', '--url', 'https://api.yonedarepo.com'], { encoding: 'utf8' });
  assert.notEqual(prod.status, 0);
  assert.match(prod.stderr, /dev only/);
});

test('a burst is stopped by errors, by a slow landing, by slow reads and by a limit error', () => {
  const fine = { writers: 100, commit: { ok: 100 }, land: { ok: 100, client: { p95_ms: 2_000 } }, read: { correct: 100, client: { p95_ms: 300 } } };
  assert.deepEqual(burstStops(fine), []);
  assert.deepEqual(burstStops({ ...fine, land: { ok: 90, client: { p95_ms: 2_000 } } }), ['errors']);
  assert.deepEqual(burstStops({ ...fine, land: { ok: 100, client: { p95_ms: 31_000 } } }), ['p95']);
  assert.deepEqual(burstStops({ ...fine, read: { correct: 100, client: { p95_ms: 3_100 } } }), ['p95']);
  assert.deepEqual(burstStops({ ...fine, overloaded: 1 }), ['limit']);
});

test('delay is client time less the server total, and only of answered requests', () => {
  const rows = [
    { status: 200, ms: 150, server: 40, edge: 'FRA' },
    { status: 200, ms: 30, server: 40, edge: 'FRA' },
    { status: 200, ms: 90, server: null, edge: 'AMS' },
    { status: 500, ms: 900, server: 10 },
  ];
  assert.deepEqual(delay(rows), { samples: 2, p50_ms: 0, p95_ms: 110, max_ms: 110 });
  assert.deepEqual(edges(rows), { FRA: 2, AMS: 1, unknown: 1 });
});

test('a regional client still answers its ping and now runs writers as a bench client', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push([String(url), init?.method]);
    if (String(url).includes('trace')) return new Response('colo=FRA\nloc=DE\n');
    if (String(url).endsWith('/commits')) return new Response('{"commit":"c1"}', { headers: { 'cf-ray': 'abc-FRA', 'server-timing': 'total;dur=12' } });
    return answer(200);
  });
  const env = { BENCH_KEY: 'k' };
  assert.equal((await worker.fetch(post({ ping: true }), env)).status, 200);
  assert.equal((await (await worker.fetch(post({ ping: true }), env)).json()).bench, REGION_VERSION);
  assert.equal((await (await worker.fetch(post({ ping: {} }), env)).json()).bench, BENCH_VERSION);
  const writers = [{ token: 't', path: 'a.txt', content: 'a' }];
  const { results } = await (await worker.fetch(post({ target: 'https://api.dev.yonedarepo.com', repo: REPO, writers }), env)).json();
  assert.deepEqual([results[0].commit.status, results[0].commit.edge, results[0].land.edge], [200, 'FRA', 'FRA']);
  assert.equal((await worker.fetch(post({ target: 'https://api.yonedarepo.com', repo: REPO, writers }), env)).status, 400);
  assert.equal((await worker.fetch(post({ ping: true }, 'wrong'), env)).status, 403);
});

test('a flood sends every step, and a client that fails counts its steps', async () => {
  const calls = [];
  const rows = await flood(async (client, body) => (calls.push(body.steps.length), calls.length === 2 ? { failed: 'gone' } : { results: body.steps.map(() => ({ status: 200 })) }), 'eu', Array.from({ length: 20 }, () => ({})));
  assert.equal(rows.length, 20);
  assert.ok(calls.every((n) => n <= 6));
  assert.ok(rows.some((r) => r.status === 0));
});

test('a limiter holds when it refuses near its limit, and a repeated sign-in counts as passed', () => {
  const rows = [...Array(32).fill({ status: 401, edge: 'FRA' }), ...Array(8).fill({ status: 429, edge: 'FRA' })];
  assert.deepEqual(tally(rows), { sent: 40, allowed: 32, refused: 8, other: 0, edges: ['FRA'] });
  assert.ok(limitHeld(tally(rows), 30));
  assert.ok(!limitHeld({ allowed: 40, refused: 0 }, 30));
  assert.ok(!limitHeld({ allowed: 300, refused: 60 }, 30));
});

test('two regions over the limit together are one counter or one each', async () => {
  const shared = await limitsBoth(async (c, body) => ({ results: body.steps.map(() => ({ status: 200 })) }), REPO, { bothReads: 12 });
  assert.equal(shared.both.allowed, 24);
  assert.deepEqual([shared.eu.sent, shared.ap.sent], [12, 12]);
});

test('a run records each item, waits out the counters, and a client that stops stops alone', async () => {
  const records = [];
  const waits = [];
  const session = (ok) => ({
    createRepo: async () => REPO,
    mintTokens: async (_, n) => Array(n).fill('t'),
    fanout: async (_, list) => list.map((w) => (w.read ? { read: { status: ok ? 200 : 500, ok, ms: 5, server: 1 } } : { commit: { status: 200, ms: 5, server: 1, started_at: 1 }, land: { status: ok ? 200 : 500, ms: 5, server: 1, started_at: 2, error: ok ? undefined : 'BROKEN' } })),
    call: async () => ({ status: 200, body: { entries: [] } }),
    cleanup: async () => [],
  });
  let at = 0;
  const outcome = await runDistance({
    sessions: { na: session(true), eu: session(false) },
    call: async (c, body) => ({ results: body.steps.map(() => ({ status: 429 })) }),
    limitRepo: REPO,
    items: [...planDistance({ clients: ['na', 'eu'], sizes: [2, 4], runs: 1 })],
    options: { ...DEFAULTS, publicReads: 6, signIns: 6 },
    record: async (name, result) => void records.push([name, result]),
    log: () => {},
    wait: async (ms) => void waits.push(ms),
    now: () => (at += 1000),
  });
  assert.deepEqual(records.map(([name]) => name), ['burst-na-2-run1', 'burst-eu-2-run1', 'burst-na-4-run1', 'limits-na-run1']);
  assert.match(outcome.stopped.eu, /2 writers: errors/);
  assert.ok(records[1][1].stops.includes('errors'));
  assert.equal(records[3][1].public.refused, 6);
  assert.deepEqual(waits, [0]);
});

const burstResult = (client, run) => ({
  kind: 'burst', client, run, writers: 100,
  commit: { client: { p50_ms: 100 + run, p95_ms: 200 }, server: { p50_ms: 40 } },
  land: { client: { p50_ms: 300, p95_ms: 900 }, server: { p50_ms: 80 } },
  read: { client: { p50_ms: 50, p95_ms: 70 }, server: { p50_ms: 10 } },
  delay: { commit: { p50_ms: 60, p95_ms: 90 }, land: { p50_ms: 62, p95_ms: 95 }, read: { p50_ms: 40, p95_ms: 50 } },
  edges: { FRA: 297, AMS: 3 }, rate_limited: 0, stops: [],
});

test('the tables report medians with their range, where clients ran and the limiters', () => {
  assert.equal(spread([3, 1, 2]), '2 (1–3)');
  assert.equal(spread([null, undefined]), '–');
  const results = [1, 2, 3].map((run) => burstResult('eu', run));
  assert.match(burstTable(results), /\| Europe \| 100 \| 3 \| Commit \| 102 \(101–103\) \| 200 \(200–200\) \| 40 \(40–40\) \| 60 \(60–60\) \| 90 \(90–90\) \|/);
  assert.match(edgeTable(results), /FRA 99\.0%, AMS 1\.0%/);
  const rounds = [{ kind: 'limits', client: 'eu', public: { allowed: 310, refused: 50 }, auth: { allowed: 31, refused: 9 } }];
  assert.match(limitTable([...rounds, ...results]), /\| Europe \| public \| 300 \| 1 \| 310 \(310–310\) \| 50 \(50–50\) \| yes \|/);
  assert.match(limitTable([...rounds, ...results]), /0 of 900 token requests refused/);
  const both = [{ kind: 'limits-both', both: { allowed: 480, refused: 0 } }];
  assert.match(limitTable(both), /\*\*no: a counter per location\*\*/);
  assert.equal(renderDistance([]), 'None yet.');
});

test('results replace only what lies between their markers', () => {
  const doc = 'a\n<!-- distance-results:start (tools/platform-distance-bench.mjs --results) -->\nold\n<!-- distance-results:end -->\nb\n';
  assert.equal(replaceDistance(doc, 'new'), doc.replace('old', 'new'));
  assert.throws(() => replaceDistance('a', 'new'), /lost its distance results markers/);
});
