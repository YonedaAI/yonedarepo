// The load test tools' pure parts (docs/load-testing.md): what they refuse, stop on and record.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cloudflareReaders, latestBacklog, objectFigures, queryTexts, workerFigures } from '../../tools/fanout-bench/cf-analytics.mjs';
import { runId, writerCredentials } from '../../tools/fanout-bench/credentials.mjs';
import { evidenceRecord, stampOf } from '../../tools/fanout-bench/driver.mjs';
import { devSpec, isDevUrl, requireDev } from '../../tools/fanout-bench/guard.mjs';
import { batchesFor, summarizeBurst } from '../../tools/fanout-bench/manyrepo.mjs';
import { parseOpen } from '../../tools/fanout-bench/open-loop.js';
import { fanOut, RELAY_MAX, splitBatches, validRelay } from '../../tools/fanout-bench/relay.js';
import { ensurePool } from '../../tools/fanout-bench/repo-pool.mjs';
import { renderResults, replaceResults, resultRows, spread } from '../../tools/fanout-bench/results.mjs';
import { limitKills, NOT_READABLE, pickWatched, repoFigures, requestsPerSample, sampleOnce, summarizeSamples, WATCHED } from '../../tools/fanout-bench/sampler.mjs';
import { estimatePlan, estimateRun, MIN_RUNS, planRuns, STAGE2 } from '../../tools/fanout-bench/stages.mjs';
import { d1Errors, isLimitError, limitErrors, stopReasons, TARGETS } from '../../tools/fanout-bench/stop.mjs';
import { pathPrefix, sustainedSummary, verdict } from '../../tools/fanout-bench/sustained.mjs';

const PLATFORM = 'https://yonedarepo-dev-platform.mlong-f01.workers.dev';
const repoId = (n) => `r${String(n).padStart(20, '0')}`;

test('only dev hosts pass; prod, lookalikes and plain http are refused', () => {
  for (const url of [PLATFORM, 'https://yonedarepo-dev-bench.mlong-f01.workers.dev', 'https://yonedarepo-dev-bench2.mlong-f01.workers.dev', 'https://dev.yonedarepo.com', 'https://api.dev.yonedarepo.com'])
    assert.ok(isDevUrl(url), url);
  for (const url of [
    'https://yonedarepo.com',
    'https://api.yonedarepo.com',
    'https://yonedarepo-prod-platform.mlong-f01.workers.dev',
    'https://yonedarepo-dev-platform.other.workers.dev',
    'https://yonedarepo-dev-a.b.mlong-f01.workers.dev',
    'https://dev.yonedarepo.com.example.org',
    'http://dev.yonedarepo.com',
    'not a url',
  ])
    assert.ok(!isDevUrl(url), url);
});

test('every url of a run is checked, and loopback needs asking for', () => {
  assert.throws(() => requireDev([PLATFORM, 'https://yonedarepo-prod-bench.mlong-f01.workers.dev']), /dev only/);
  assert.throws(() => requireDev(['http://127.0.0.1:8787']), /dev only/);
  assert.doesNotThrow(() => requireDev(['http://127.0.0.1:8787', undefined], { local: true }));
  assert.throws(() => requireDev(['https://yonedarepo.com'], { local: true }), /dev only/);
});

test('a spec that is not dev allows nothing, whatever its hosts', () => {
  assert.ok(!isDevUrl(PLATFORM, { ...devSpec(), env: 'prod' }));
});

test('the stop rules are the doc\'s: over 1% errors, p95 over 3x target, a limit error', () => {
  const base = { total: 1000, errors: 0, p95_ms: 100, target_ms: 3000 };
  assert.deepEqual(stopReasons(base), []);
  assert.deepEqual(stopReasons({ ...base, errors: 10 }), [], 'exactly 1% is not above it');
  assert.deepEqual(stopReasons({ ...base, errors: 11 }), ['errors']);
  assert.deepEqual(stopReasons({ ...base, p95_ms: 9000 }), [], 'exactly 3x is not over it');
  assert.deepEqual(stopReasons({ ...base, p95_ms: 9001 }), ['p95']);
  assert.deepEqual(stopReasons({ ...base, p95_ms: null }), ['p95'], 'nothing landed');
  assert.deepEqual(stopReasons({ ...base, limits: 1 }), ['limit']);
  assert.deepEqual(stopReasons({ total: 0, errors: 0, p95_ms: null, target_ms: 3000 }), []);
});

test('Cloudflare limit errors are told from ordinary failures', () => {
  for (const text of ['Too many subrequests.', 'Durable Object is overloaded. Requests queued for too long.', 'Exceeded the maximum database size.', 'Durable Object storage operation exceeded timeout', 'bench client answered 503 after 30001 ms: error code: 1102', 'Worker exceeded resource limits', 'Too many requests queued'])
    assert.ok(isLimitError(text), text);
  for (const text of ['CONFLICT: main moved', 'error code: 1101', 'Not found', '', undefined]) assert.ok(!isLimitError(text), text);
  assert.equal(limitErrors([{ status: 0, client_error: 'error code: 1015' }, { status: 500, message: 'nope' }, null]).length, 1);
  assert.equal(d1Errors([{ message: 'D1_ERROR: database is locked' }, { message: 'D1 DB is overloaded' }, { message: 'ID1 is fine' }]).length, 2);
});

const arrival = (status, extra = {}) => ({ scheduled_at: 0, commit: { status: 200, started_at: 0, ms: 50 }, land: { status, started_at: 50, ms: 50, ...extra } });

test('a window counts abandoned arrivals, but not conflicts answered as conflicts', () => {
  const landed = Array.from({ length: 95 }, () => arrival(200));
  assert.deepEqual(verdict([...landed, ...Array.from({ length: 5 }, () => arrival(409, { error: 'CONFLICT' }))], 3000), []);
  assert.deepEqual(verdict([...landed, ...Array.from({ length: 5 }, () => arrival(500, { error: 'INTERNAL' }))], 3000), ['errors']);
  assert.deepEqual(verdict([...landed, ...Array.from({ length: 5 }, () => ({ scheduled_at: 0, abandoned: true }))], 3000), ['errors']);
  assert.deepEqual(verdict(landed, 3000, 1), ['limit'], 'a kill only analytics show');
  assert.ok(verdict([...landed, arrival(503, { message: 'Durable Object is overloaded.' })], 3000).includes('limit'));
});

test('a burst stops on its land p95 and keeps conflicts apart', () => {
  const write = (repo, land) => ({ repo, commit: { status: 200, ms: 10, server: 1 }, land: { status: 200, started_at: 0, ms: 100, ...land } });
  const repos = [repoId(1), repoId(2)];
  const fine = summarizeBurst([write(repos[0]), write(repos[1])], repos);
  assert.deepEqual(fine.stop, []);
  assert.equal(fine.land.ok, 2);
  const slow = summarizeBurst([write(repos[0], { ms: TARGETS.many_repos_ms * 3 + 1 })], repos);
  assert.deepEqual(slow.stop, ['p95']);
  const conflicted = summarizeBurst([...Array.from({ length: 200 }, () => write(repos[0])), write(repos[1], { status: 409, error: 'CONFLICT' })], repos);
  assert.deepEqual([conflicted.failed, conflicted.conflicts, conflicted.stop], [0, 1, []]);
});

test('a commit that failed counts as a failed writer', () => {
  const failed = { repo: repoId(1), commit: { status: 503, error: 'X', message: 'Too many subrequests' }, land: null };
  assert.deepEqual(summarizeBurst([failed], [repoId(1)]).stop, ['errors', 'p95', 'limit']);
});

test('paths are unique to a run; spread crosses top-level directories, single stays in one', () => {
  const at = (layout, shard, segment, run = 'x1') => pathPrefix({ layout, run, rate: 100, shard, segment });
  assert.equal(at('single', 3, 2), 'load/x1/r100/s3/g2');
  assert.notEqual(at('spread', 0, 0, 'x1'), at('spread', 0, 0, 'x2'));
  const tops = (layout) => new Set(Array.from({ length: 100 }, (_, shard) => at(layout, shard, 0).split('/')[0]));
  assert.equal(tops('single').size, 1);
  assert.equal(tops('spread').size, 32);
  // Few shards still cross directories over the segments of a long run.
  const few = new Set(Array.from({ length: 30 }, (_, segment) => at('spread', 0, segment).split('/')[0]));
  assert.equal(few.size, 30);
  assert.ok(parseOpen({ rate: 1, duration_ms: 1000, prefix: pathPrefix({ layout: 'spread', run: runId(), rate: 100, shard: 99, segment: 29 }), token: 't' }));
});

test('run ids fit token names and bench paths', () => {
  const id = runId(Date.UTC(2026, 9, 31));
  assert.match(`b${id}w999`, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  assert.match(id, /^[a-z0-9]+$/);
  assert.notEqual(runId(1), runId(2));
});

test('a burst batches five writers at a time, on paths of this run', () => {
  const batches = batchesFor(repoId(1), 0, 12, 'x9', (_, slot) => `token${slot}`);
  assert.deepEqual(batches.map((b) => b.writers.length), [5, 5, 2]);
  assert.equal(batches[2].writers[1].path, 'bench/x9/w11.txt');
  assert.equal(batches[2].writers[1].token, 'token11');
});

test('relay groups are six at most, in order, with nothing lost', () => {
  const batches = Array.from({ length: RELAY_MAX }, (_, i) => i);
  const groups = splitBatches(batches);
  assert.equal(groups.length, 6);
  assert.deepEqual(groups.flat(), batches);
  assert.ok(Math.max(...groups.map((g) => g.length)) - Math.min(...groups.map((g) => g.length)) <= 1);
  assert.deepEqual(splitBatches([1, 2]), [[1], [2]]);
});

test('relay requests out of bounds are refused', () => {
  const batch = { repo: repoId(1), writers: [{}] };
  assert.ok(validRelay([batch]));
  assert.ok(!validRelay([]));
  assert.ok(!validRelay(Array(RELAY_MAX + 1).fill(batch)));
  assert.ok(!validRelay([{ ...batch, repo: '../x' }]));
  assert.ok(!validRelay([{ ...batch, writers: Array(6).fill({}) }]));
  assert.ok(!validRelay('x'));
});

test('a relay call that fails counts its own writers as failed, not the rest', async () => {
  const batches = [{ repo: repoId(1), writers: [{}, {}] }, { repo: repoId(2), writers: [{}] }];
  const send = async (_, init) => {
    const body = JSON.parse(init.body);
    assert.equal(init.headers['x-bench-key'], 'k');
    if (body.repo === repoId(1)) return { status: 503, text: async () => 'error code: 1102' };
    return { status: 200, json: async () => ({ results: [{ commit: { status: 200 }, land: { status: 200 } }] }) };
  };
  const replies = await fanOut({ origin: 'http://x', key: 'k', target: 't', batches }, send);
  assert.equal(replies[0].results.length, 2);
  assert.match(replies[0].results[0].commit.message, /1102/);
  assert.equal(replies[1].results[0].land.status, 200);
});

const sample = (at, head, db_bytes, extra = {}) => ({
  at,
  repos: [{ repo: 'r', floor: extra.floor ?? 0, head, tail_rows: extra.tail ?? head, keep_versions: 10_000, db_bytes, table_rows: { commits: head, tokens: 3 }, outbox_pending: extra.outbox ?? 0 }],
  cloudflare: extra.cloudflare ?? {},
  unreadable: extra.unreadable ?? {},
});

test('samples add up to growth per version and whether compaction kept up', () => {
  const summary = summarizeSamples([sample(0, 100, 1_000_000), sample(1, 1100, 6_000_000, { outbox: 9 }), sample(2, 1100, 6_000_000, { floor: 1024, tail: 76, outbox: 2 })]);
  const [repo] = summary.repos;
  assert.equal(repo.growth.bytes_per_version, 5000);
  assert.deepEqual(repo.growth.rows_per_version, { commits: 1 }, 'unchanged tables are left out');
  assert.deepEqual([repo.compaction.floor_last, repo.compaction.tail_max, repo.compaction.tail_last, repo.compaction.kept_up], [1024, 1100, 76, true]);
  assert.deepEqual(repo.outbox, { max: 9, last: 2 });
  assert.deepEqual(summary.not_readable, NOT_READABLE);
});

test('a tail past its bound says compaction did not keep up', () => {
  const summary = summarizeSamples([sample(0, 0, 1), sample(1, 20_000, 2)]);
  assert.equal(summary.repos[0].compaction.bound, 11_024);
  assert.equal(summary.repos[0].compaction.kept_up, false);
});

test('the sampler reads with GET only, and names what it could not read', async () => {
  const seen = [];
  const session = {
    call: async (method, path) => {
      seen.push([method, path]);
      if (path.endsWith('/compaction')) return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
      return { status: 200, body: { objects: { pending: 4 } } };
    },
  };
  const ids = [repoId(1), repoId(2), repoId(3)];
  const taken = await sampleOnce(session, ids, { backlog: async () => ({ jobs: 3 }), d1: async () => { throw new Error('no such field'); } }, { start: 0, end: 1 });
  assert.ok(seen.every(([method]) => method === 'GET'), JSON.stringify(seen));
  assert.equal(seen.filter(([, path]) => !path.endsWith('/compaction')).length, 2, 'only two repositories ask their 64 shards');
  assert.deepEqual(taken.repos, []);
  assert.match(taken.unreadable.compaction, /404 NOT_FOUND/);
  assert.ok(!taken.unreadable.compaction.includes('r0000'), 'no repository ids in a reason');
  assert.equal(taken.unreadable.d1, 'no such field');
  assert.deepEqual(taken.cloudflare.backlog, { jobs: 3 });
  const bare = await sampleOnce(session, [], null, { start: 0, end: 1 });
  assert.match(bare.unreadable.analytics, /CF_ANALYTICS_TOKEN/);
});

test('figures come from the compaction and status answers', () => {
  const figures = repoFigures('r', { floor: 5, head: 9, tail_rows: 4, retention: { keep_versions: 64 }, storage: { db_bytes: 10, table_rows: { txlog: 9 } } }, { objects: { pending: 2 } });
  assert.deepEqual(figures, { repo: 'r', floor: 5, head: 9, tail_rows: 4, keep_versions: 64, db_bytes: 10, table_rows: { txlog: 9 }, outbox_pending: 2 });
  assert.equal('outbox_pending' in repoFigures('r', {}), false);
});

test('a large run is watched at a few repositories across it, at a known cost', () => {
  const ids = Array.from({ length: 1000 }, (_, i) => i);
  assert.deepEqual(pickWatched(ids), [0, 200, 400, 600, 800]);
  assert.deepEqual(pickWatched([1, 2]), [1, 2]);
  assert.equal(WATCHED, 5);
  assert.equal(requestsPerSample(1000), 5 + 2 * 65);
  assert.equal(requestsPerSample(1), 1 + 65);
});

test('resource kills read as a limit, and their absence as none', () => {
  assert.equal(limitKills({ cloudflare: { objects: objectFigures([{ sum: { exceededCpuErrors: 2, exceededMemoryErrors: 1, fatalInternalErrors: 5 } }]) } }), 3);
  assert.equal(limitKills({ cloudflare: {} }), 0);
  assert.equal(limitKills(undefined), 0);
});

test('Cloudflare analytics only query, and shape what they answer', () => {
  assert.ok(queryTexts().every((q) => q.startsWith('query ') && !/mutation/i.test(q)));
  assert.deepEqual(latestBacklog([{ avg: { messages: 4 }, dimensions: { queueId: 'a' } }, { avg: { messages: 9 }, dimensions: { queueId: 'a' } }], { jobs: 'a', dead_letter: 'b' }), { jobs: 9, dead_letter: 0 });
  assert.deepEqual(workerFigures([{ sum: { requests: 9, errors: 0, subrequests: 3 }, dimensions: { status: 'success' } }, { sum: { requests: 2, errors: 2, subrequests: 0 }, dimensions: { status: 'exceededResources' } }]), { requests: 11, errors: 2, subrequests: 3, statuses: { exceededResources: 2 } });
});

test('one unreadable analytics source fails alone, and ids are looked up again after a failure', async () => {
  let fail = true;
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/graphql')) {
      const { query } = JSON.parse(init.body);
      if (query.startsWith('query D1')) return Response.json({ errors: [{ message: 'unknown field' }] });
      return Response.json({ data: { viewer: { accounts: [{ rows: [] }] } } });
    }
    if (String(url).includes('/queues')) {
      if (fail) return Response.json({ success: false }, { status: 403 });
      return Response.json({ success: true, result: [{ queue_name: 's-jobs', queue_id: 'j' }, { queue_name: 's-checks', queue_id: 'c' }, { queue_name: 's-dead-letter', queue_id: 'd' }] });
    }
    return Response.json({ success: true, result: { bindings: [{ type: 'durable_object_namespace', class_name: 'SourceRepository', namespace_id: 'n' }] } });
  };
  const readers = cloudflareReaders({ token: 't', spec: { account: 'a', script: 's', d1: 'db' }, fetchImpl });
  const window = { start: 0, end: 1000 };
  await assert.rejects(readers.backlog(window), /queues: HTTP 403/);
  fail = false;
  assert.deepEqual(await readers.backlog(window), { jobs: 0, checks: 0, dead_letter: 0 });
  assert.deepEqual((await readers.workers(window)).errors, 0);
  await assert.rejects(readers.d1(window), /unknown field/);
});

test('a pool is reused: nothing recreated, nothing past the size forgotten, dead ones replaced', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pool-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'pool.json');
  let made = 0;
  const dead = new Set();
  const session = {
    url: 'https://x',
    call: async (_, path) => ({ status: dead.has(path.split('/')[2]) ? 404 : 200 }),
    createKept: async (name) => ({ id: repoId(++made), name }),
  };
  assert.equal((await ensurePool(session, { file, size: 45, prefix: 'p' })).length, 45);
  assert.equal(made, 45);
  const small = await ensurePool(session, { file, size: 20, prefix: 'p' });
  assert.equal(small.length, 20);
  assert.equal(made, 45, 'reused, not remade');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).repos.length, 45, 'a smaller run keeps the rest');
  dead.add(small[3]);
  const healed = await ensurePool(session, { file, size: 20, prefix: 'p' });
  assert.equal(made, 46);
  assert.ok(!healed.includes(small[3]));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).repos.length, 45);
  await assert.rejects(ensurePool({ ...session, url: 'https://y' }, { file, size: 1, prefix: 'p' }), /belongs to/);
  const text = await readFile(file, 'utf8');
  assert.ok(!/token|yrp_|ypat_/.test(text));
});

test('repository tokens are fresh per repository and revoked; PATs are shared within the cap', async () => {
  const minted = [];
  const revoked = [];
  const session = {
    mintTokens: async (repo, count, label) => {
      minted.push([repo, count, label]);
      return Array.from({ length: count }, (_, i) => `${repo}-${label}${i}`);
    },
    revokeTokens: async (repo, count, label) => {
      revoked.push([repo, count, label]);
      return 0;
    },
    post: async (path, body) => {
      assert.equal(path, '/tokens');
      assert.equal(body.expires_days, 1);
      assert.deepEqual(body.scopes, ['repo:read', 'repo:write', 'repo:land']);
      return { id: `pat${body.name}`, token: `t-${body.name}` };
    },
    call: async (method, path) => {
      revoked.push([method, path]);
      return { status: 200 };
    },
  };
  const yrp = await writerCredentials(session, ['a', 'b'], { principals: 'tokens', slots: 3, run: 'x1' });
  assert.equal(yrp.tokenFor(1, 2), 'b-bx1w2');
  assert.equal(await yrp.revoke(), 0);
  assert.deepEqual(revoked, [['a', 3, 'bx1w'], ['b', 3, 'bx1w']]);
  revoked.length = 0;
  const pat = await writerCredentials(session, ['a', 'b'], { principals: 'pat', slots: 3, run: 'x1', pats: 2 });
  assert.notEqual(pat.tokenFor(0, 0), pat.tokenFor(0, 1));
  assert.equal(pat.tokenFor(0, 0), pat.tokenFor(0, 2));
  await pat.revoke();
  assert.equal(revoked.length, 2);
  const capped = await writerCredentials(session, ['a'], { principals: 'pat', slots: 1, run: 'x1', pats: 500 });
  await capped.revoke();
  assert.equal(revoked.length, 42, 'at most 40 of the account\'s 50 live tokens');
});

test('evidence refuses a credential, and stamps sort by time', () => {
  const at = { recorded_at: 'now', revision: 'abc' };
  assert.equal(evidenceRecord('t', { ok: 1 }, at).record.schema, 2);
  assert.throws(() => evidenceRecord('t', { token: `yrp_${'a'.repeat(32)}` }, at), /holds a token/);
  assert.throws(() => evidenceRecord('t', { token: `ypat_${'a'.repeat(43)}` }, at), /holds a token/);
  assert.doesNotThrow(() => evidenceRecord('t', { name: 'bx1w3', scopes: 'yrp_' }, at));
  const stamp = stampOf(new Date('2026-10-31T12:30:15.250Z'));
  assert.equal(stamp, '2026-10-31T12-30-15-250Z');
  assert.ok(!/[:.]/.test(stamp));
});

const record = (at, summary, target = PLATFORM) => ({
  schema: 2,
  target,
  recorded_at: at,
  revision: 'abcdef0123456789',
  result: { summary: { stage: '2', size: '20 × 10', arm: 'tokens', clients: 1, rate_per_s: 100, land_p95_ms: 500, arrivals: 200, errors: 0, d1_errors: 0, bytes_per_version: null, compaction_kept_up: null, what_broke: null, ...summary } },
});

test('the results table is min, median and max per size and arm, from dev evidence only', () => {
  const rows = resultRows([
    record('2026-11-01T01:00:00Z', { rate_per_s: 90, land_p95_ms: 700 }),
    record('2026-11-01T02:00:00Z', { rate_per_s: 110, land_p95_ms: 500, errors: 3 }),
    record('2026-11-01T03:00:00Z', { rate_per_s: 100, land_p95_ms: 600, what_broke: 'errors: 500 X|Y' }),
    record('2026-11-01T03:00:00Z', { arm: 'pat', rate_per_s: 50 }),
    record('2026-11-01T03:00:00Z', {}, 'http://127.0.0.1:1'),
    record('2026-11-01T03:00:00Z', { stage: null }),
    { ...record('2026-11-01T03:00:00Z', {}), schema: 1 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].arm, 'tokens');
  assert.deepEqual(rows[1].rate, { min: 90, median: 100, max: 110 });
  assert.deepEqual(rows[1].p95, { min: 500, median: 600, max: 700 });
  assert.equal(rows[1].runs, 3);
  assert.equal(rows[1].commit, 'abcdef01');
  const table = renderResults(rows);
  assert.match(table, /\| 20 × 10 \| tokens \| 1 \| 3 \| 90 \/ 100 \/ 110 \| 500 \/ 600 \/ 700 \| 3 of 600 \|/);
  assert.match(table, /errors: 500 X\/Y/, 'a pipe in a message does not break the table');
  assert.ok(!/r0{5}/.test(table));
  assert.equal(renderResults([]), 'None yet.');
  assert.deepEqual(spread([3, null, 1, 2, undefined]), { min: 1, median: 2, max: 3 });
  assert.equal(spread([]), null);
});

test('the doc\'s results are replaced between their markers and nowhere else', async () => {
  const doc = await readFile(new URL('../../docs/load-testing.md', import.meta.url), 'utf8');
  const once = replaceResults(doc, 'TABLE ONE');
  const twice = replaceResults(once, 'TABLE TWO');
  assert.ok(once.includes('TABLE ONE'));
  assert.ok(!twice.includes('TABLE ONE'));
  assert.equal(replaceResults(twice, 'TABLE ONE'), once);
  assert.throws(() => replaceResults('no markers', 'x'), /markers/);
});

test('the plan covers the stage sizes with at least three runs of each, stage 3 first', () => {
  const items = planRuns();
  assert.equal(items[0].stage, '3');
  for (const size of [20, 100, 500, 1000]) for (const arm of ['tokens', 'pat']) assert.equal(items.filter((i) => i.stage === '2' && i.repos === size && i.arm === arm).length, MIN_RUNS);
  const stage3 = items.filter((i) => i.stage === '3');
  assert.equal(stage3.filter((i) => i.arm === 'one-repo' && i.rate === 100 && i.seconds === 1800).length, MIN_RUNS);
  assert.equal(stage3.filter((i) => i.arm === 'twenty-repos' && i.repos === 20 && i.rate === 5).length, MIN_RUNS);
  assert.equal(stage3.filter((i) => i.layout === 'single').length, MIN_RUNS);
  assert.ok(!items.some((i) => i.clients === 2));
  const two = planRuns({ stages: ['2'], clients: 2 }).filter((i) => i.clients === 2);
  assert.equal(two.length, MIN_RUNS * STAGE2.arms.length);
  assert.ok(two.every((i) => i.repos === 1000));
});

test('the estimate counts what a run sends', () => {
  const burst = estimateRun({ stage: '2', repos: 100, writers: 10, arm: 'tokens' });
  assert.equal(burst.measured, 2000);
  assert.equal(burst.setup, 1000 * 2 + 100, 'mint, revoke, and a look at each saved repository');
  assert.equal(burst.bench_invocations, 400);
  assert.equal(estimateRun({ stage: '2', repos: 100, writers: 10, arm: 'pat' }, { pats: 10 }).setup, 20 + 100);
  const long = estimateRun({ stage: '3', repos: 1, rate: 100, seconds: 1800 });
  assert.equal(long.measured, 360_000);
  assert.equal(long.setup, 201);
  assert.equal(long.bench_invocations, 3000);
  assert.ok(long.seconds >= 1800);
  assert.equal(estimateRun({ stage: '3', repos: 20, rate: 5, seconds: 1800 }).measured, 360_000);
  const cost = estimatePlan(planRuns(), { poolMissing: 40 });
  assert.equal(cost.runs, 33);
  assert.equal(cost.requests.measured, 9 * 360_000 + 3 * 2 * 2 * 1620 * 10);
  assert.equal(cost.requests.total, cost.requests.measured + cost.requests.setup + cost.requests.sampler);
  assert.equal(cost.stage_2.runs + cost.stage_3.runs, cost.runs);
});

test('a sustained summary names what broke and the sampler\'s findings', () => {
  const step = { rate: 100, arrivals: 1000, refused: 7, conflicts: 2, d1_errors: 1, client: { abandoned: 1 }, achieved_per_second: 88, latency: { p95_ms: 9500 }, missed: ['achieved', 'p95'], stopped: { segment: 3, reasons: ['p95'] }, errors: [['500 X: y', 5]] };
  const server = { summary: { repos: [{ growth: { bytes_per_version: 5200 }, compaction: { kept_up: false } }] } };
  const summary = sustainedSummary([step], { stage: '3', principals: 'tokens', layout: 'single', step_s: 1800 }, 1, server, 2);
  assert.deepEqual([summary.size, summary.arm, summary.clients, summary.errors, summary.bytes_per_version, summary.compaction_kept_up], ['1 × 100/s, 1800 s', 'tokens single', 2, 6, 5200, false]);
  assert.equal(summary.what_broke, 'achieved, p95: 500 X: y');
  assert.equal(sustainedSummary([{ ...step, missed: [], stopped: null }], { stage: '3', step_s: 60 }, 20, null, 1).what_broke, null);
});

test('a results file on disk round-trips through the updater', async (t) => {
  const { updateResults } = await import('../../tools/fanout-bench/results.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'results-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const doc = join(dir, 'doc.md');
  await writeFile(doc, 'before\n<!-- results:start (tools/platform-load-stages.mjs --results) -->\nNone yet.\n<!-- results:end -->\nafter\n');
  await writeFile(join(dir, 'stage2-a.json'), JSON.stringify(record('2026-11-01T01:00:00Z', {})));
  await writeFile(join(dir, 'pool-stage2.json'), JSON.stringify({ repos: [] }));
  assert.equal(await updateResults(dir, doc), 1);
  const text = await readFile(doc, 'utf8');
  assert.ok(text.startsWith('before\n') && text.endsWith('after\n'));
  assert.match(text, /\| 20 × 10 \| tokens \|/);
});
