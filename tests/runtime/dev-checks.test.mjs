// The enterprise checks' own logic (tools/staging/dev-checks*.mjs), with no platform: what they may
// touch, what proves a copy gone, what their logs and dry runs say, and that each flow passes on
// a platform that behaves and fails on one that doesn't, one bug at a time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Recorder } from '../../tools/staging/client.mjs';
import { backfillSteps } from '../../tools/staging/dev-checks-backfill.mjs';
import { cloudflare, queryTexts } from '../../tools/staging/dev-checks-cf.mjs';
import { backfillEstimate, eraseCost, eraseRequests, parseBackfill } from '../../tools/staging/dev-checks-cost.mjs';
import { eraseSteps } from '../../tools/staging/dev-checks-erase.mjs';
import { holdSteps, holdWaitSteps } from '../../tools/staging/dev-checks-hold.mjs';
import {
  auditGaps,
  copiesLeft,
  DEV,
  eraseStory,
  keyKind,
  Ledger,
  limitsBroken,
  logLines,
  parseTail,
  proofTable,
  r2Prefixes,
  requireDev,
  rootOf,
  scrub,
  shortWindow,
} from '../../tools/staging/dev-checks-lib.mjs';
import { cleanUp, newRepo, runSteps } from '../../tools/staging/dev-checks-repos.mjs';
import { undoSteps } from '../../tools/staging/dev-checks-undo.mjs';
import { world } from './support/dev-checks-world.mjs';

const ID = `r${'a'.repeat(20)}`;

function contextOf(options) {
  const place = world(options);
  const ctx = {
    stamp: 'test',
    secrets: new Set(),
    owner: place.session('owner'),
    ownerName: 'kit',
    member: place.session('member'),
    memberName: 'kit_m',
    operator: place.session('operator'),
    anon: place.session('anonymous'),
    bearer: place.session,
    cf: place.cf,
    ledger: new Ledger(),
    clock: place.clock,
    git: place.git,
    knownObjects: new Set(),
    evidence: () => {},
  };
  return { ctx, place };
}

async function run(steps) {
  const quiet = process.stdout.write;
  process.stdout.write = () => true;
  const recorder = new Recorder();
  try {
    const passed = await runSteps(recorder, steps);
    return { passed, items: recorder.items };
  } finally {
    process.stdout.write = quiet;
  }
}

const failedAt = ({ items }) => items.find((i) => i.status === 'fail');

test('reaches dev only', () => {
  assert.equal(requireDev(DEV.origin), DEV.origin);
  assert.throws(() => requireDev('https://yonedarepo.com'), /Dev only/);
});

test('a run deletes only what it made, under a test name', () => {
  const ledger = new Ledger();
  assert.throws(() => ledger.add({ id: ID, name: 'oss-cobra' }), /Not a test name/);
  assert.throws(() => ledger.add({ id: ID, name: 'ladder-svelte-1' }), /Not a test name/);
  assert.throws(() => ledger.deletePath(ID), /Not made by this run/);
  ledger.add({ id: ID, name: 'dev-check-undo-1' });
  assert.equal(ledger.deletePath(ID), `/repos/${ID}?confirm=dev-check-undo-1`);
  assert.throws(() => ledger.addOrg('acme'), /Not a test org/);
  assert.throws(() => ledger.orgPath('dev_check_1'), /Not made by this run/);
});

test('a test window is labelled, and neither no window nor a long one passes', () => {
  const { ms, label } = shortWindow(0.0035);
  assert.equal(ms, 302_400);
  assert.match(label, /SHORT TEST WINDOW, dev only: 302 s/);
  assert.throws(() => shortWindow(undefined), /off on this deploy/);
  assert.throws(() => shortWindow(0), /off on this deploy/);
  assert.throws(() => shortWindow(30), /short test window/);
});

test('the copies of a repository are named from its store', () => {
  assert.deepEqual(r2Prefixes(ID, `platform:${ID}`), [`platform/v1/${ID}/`, `derived/v1/${ID}/`]);
  assert.deepEqual(r2Prefixes(ID, `r2:yr-${ID}`), [`platform/v1/${ID}/`, `derived/v1/${ID}/`, `store/v1/yr-${ID}/`]);
  assert.equal(keyKind(`platform/v1/${ID}/lfs/abc`), 'lfs');
});

test('gone needs both an empty probe and something there before', () => {
  const empty = { keys: 0 };
  const before = { d1: { platform_repos: 1 }, r2: { a: { keys: 4 }, b: empty }, object: { state: 'tombstone' } };
  const after = { d1: { platform_repos: 0 }, r2: { a: empty, b: empty }, object: { state: 'erased' } };
  assert.deepEqual(copiesLeft(after), []);
  const proof = Object.fromEntries(proofTable(before, after).map((r) => [r.copy, r.verdict]));
  assert.deepEqual(proof, { 'd1 platform_repos': 'gone', 'r2 a': 'gone', 'r2 b': 'not exercised', 'repository object': 'gone' });
  const left = { ...after, r2: { a: { keys: 1 }, b: empty }, object: { state: 'tombstone' } };
  assert.deepEqual(copiesLeft(left), ['r2:a=1', 'object:tombstone']);
  assert.equal(proofTable(before, left).find((r) => r.copy === 'r2 a').verdict, 'left');
});

test('tail output parses as a stream of pretty objects, and a cut one is dropped', () => {
  const event = { outcome: 'ok', logs: [{ timestamp: 5, message: ['{"event":"repo.erase","repo":"r","phase":"erased","rows":3}'] }] };
  const text = `Connected {not json}\n${JSON.stringify(event, null, 2)}\n${JSON.stringify({ outcome: 'ok', logs: [{ message: ['a "} brace'] }] })}\n{"outcome":"o`;
  const events = parseTail(text);
  assert.equal(events.length, 2);
  assert.deepEqual(logLines(events), [{ at: 5, event: 'repo.erase', repo: 'r', phase: 'erased', rows: 3 }]);
});

const line = (timestamp, fields) => ({ timestamp, message: [JSON.stringify({ event: 'repo.erase', repo: ID, ...fields })] });

test('an erase story adds up its jobs, and each bound can break it', () => {
  const events = [
    { outcome: 'ok', logs: [line(1, { phase: 'objects', db_bytes: 900 }), line(2, { phase: 'records', rows: 200_000 })] },
    { outcome: 'ok', logs: [line(9, { phase: 'erased', rows: 1000, db_bytes: 40 })] },
    { outcome: 'ok', logs: [{ timestamp: 3, message: [JSON.stringify({ event: 'repo.erase', repo: 'other', phase: 'erased', rows: 9 })] }] },
  ];
  const story = eraseStory(events, ID);
  assert.deepEqual(
    { jobs: story.jobs, rows: story.rows, most: story.most_rows_in_a_job, ms: story.erase_ms, end: story.db_bytes_at_end, shards: story.shards_cleared },
    { jobs: 2, rows: 201_000, most: 200_000, ms: 8, end: 40, shards: true },
  );
  assert.deepEqual(limitsBroken(story), []);
  assert.match(limitsBroken({ ...story, most_rows_in_a_job: 200_001 })[0], /200001 rows/);
  assert.match(limitsBroken({ ...story, jobs: 1 })[0], /at least 2 expected/);
  assert.match(limitsBroken({ ...story, outcomes: { ok: 2, exceededCpu: 1 } })[0], /1 invocations ended exceededCpu/);
});

test('requests and cost follow the bounds', () => {
  const usage = eraseRequests({ keys: 2500, rows: 400_000, refs: 3, prefixes: 2 });
  assert.deepEqual(usage, { r2_lists: 7, r2_deletes: 3, do_requests: 6 + 201 + 64 + 8, do_rows_written: 800_000, queue_messages: 4, erase_jobs: 3, steps: 201 });
  assert.equal(eraseRequests({ keys: 0, rows: 0, refs: 9999 }).do_requests, 6 + 1 + 64 + 1026);
  const cost = eraseCost(usage);
  assert.ok(Math.abs(cost.do_rows_written - 0.8) < 1e-9);
  assert.ok(Math.abs(cost.total_usd - (cost.r2_lists + cost.r2_deletes + cost.do_requests + cost.do_rows_written + cost.queue)) < 1e-9);
});

test('a dry run parses into states and an estimate', () => {
  const object = (c) => c.repeat(64);
  const output = [
    `tombstone ${object('a')} ${ID} 2000000`,
    `unnamed ${object('b')} - 1000`,
    `erased ${object('c')} - 500`,
    'page done: --after abc',
    `dev: 10 objects asked, 2001500 bytes outside live repositories: {"erased": 1, "live": 7, "tombstone": 1, "unnamed": 1}`,
  ].join('\n');
  const parsed = parseBackfill(output);
  assert.equal(parsed.entries.length, 3);
  assert.deepEqual(parsed.summary, { asked: 10, bytes: 2001500, states: { erased: 1, live: 7, tombstone: 1, unnamed: 1 } });
  const estimate = backfillEstimate(parsed, { delayMs: 1000, pollMs: 5000 });
  assert.equal(estimate.tombstones, 1);
  assert.equal(estimate.left_alone, 1);
  assert.equal(estimate.bytes, 2_000_000);
  assert.deepEqual(estimate.largest, [{ repo: ID, bytes: 2_000_000 }]);
  assert.ok(Math.abs(estimate.hours_at_least - 15 / 3600) < 1e-9);
  assert.equal(estimate.usage.erase_jobs, 1);
  assert.ok(estimate.cost.total_usd > 0);
  assert.equal(backfillEstimate(parseBackfill('')).cost, null);
});

test('audit gaps name what is missing, and secrets never survive', () => {
  assert.deepEqual(auditGaps([{ action: 'a', target: 'x' }, { action: 'b', target: 'y' }], [{ action: 'a', target: 'x', at: 1 }]), [{ action: 'b', target: 'y' }]);
  assert.equal(scrub('token=abc end', new Set(['abc', undefined])), 'token=<secret> end');
  assert.equal(rootOf('/code/repo/.git'), '/code/repo');
});

const jsonAnswer = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('D1 takes reads only, and a failed read throws', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => (sent.push({ url, init }), jsonAnswer({ success: true, result: [{ success: true, results: [{ n: 2 }] }] }));
  const cf = cloudflare({ token: 'SECRET', account: 'acc', database: 'db', fetchImpl });
  assert.deepEqual(await cf.d1('SELECT COUNT(*) AS n FROM platform_repos WHERE id=?', ['r']), [{ n: 2 }]);
  assert.ok(!sent[0].url.includes('SECRET'), 'the token stays out of the URL');
  await assert.rejects(cf.d1('DELETE FROM platform_repos'), /Reads only/);
  await assert.rejects(cf.d1('SELECT 1; DROP TABLE x'), /Reads only/);
  const down = cloudflare({ token: 't', account: 'acc', database: 'db', fetchImpl: async () => jsonAnswer({ success: false }, 500) });
  await assert.rejects(down.d1('SELECT 1'), /HTTP 500/);
});

test('R2 pages to the end, and a failed page never reads as empty', async () => {
  const pages = [
    { success: true, result: [{ key: `platform/v1/${ID}/git/a`, size: 3 }], result_info: { is_truncated: true, cursor: 'next' } },
    { success: true, result: [{ key: `platform/v1/${ID}/lfs/b`, size: 4 }], result_info: { is_truncated: false } },
  ];
  const asked = [];
  const cf = cloudflare({ token: 't', account: 'acc', bucket: 'b', fetchImpl: async (url) => (asked.push(url), jsonAnswer(pages.shift())) });
  assert.deepEqual(await cf.r2(`platform/v1/${ID}/`), { keys: 2, bytes: 7, kinds: { git: 1, lfs: 1 }, pages: 2 });
  assert.match(asked[1], /cursor=next/);
  const down = cloudflare({ token: 't', account: 'acc', bucket: 'b', fetchImpl: async () => jsonAnswer({}, 503) });
  await assert.rejects(down.r2('x/'), /HTTP 503/);
});

test('every analytics query only reads', () => {
  for (const text of queryTexts()) assert.match(text, /^query /);
});

test('undo passes on a platform that behaves', async () => {
  const { ctx } = contextOf();
  const result = await run(undoSteps(ctx));
  assert.deepEqual(failedAt(result), undefined);
  assert.equal(result.passed, true);
  const proof = result.items.find((i) => i.id === 'U4').metrics.proof;
  assert.ok(proof.every((r) => r.verdict !== 'left'));
  assert.equal(proof.find((r) => r.copy === 'repository object').verdict, 'gone');
});

for (const [bug, step] of [
  ['purgeInWindow', 'U2'],
  ['contentChanged', 'U3'],
  ['oldTokenSurvives', 'U3'],
  ['restoreAfterPurge', 'U4'],
  ['leaveR2Key', 'U4'],
  ['probeFails', 'U1'],
])
  test(`undo fails on ${bug}`, async () => {
    const { ctx } = contextOf({ bugs: { [bug]: true } });
    const result = await run(undoSteps(ctx));
    assert.equal(result.passed, false);
    assert.equal(failedAt(result).id, step, failedAt(result).reason);
    assert.ok(result.items.filter((i) => i.status === 'skip').every((i) => /after U\d failed/.test(i.reason)));
  });

test('undo refuses to run without a short window', async () => {
  const { ctx } = contextOf({ windowMs: 0 });
  const result = await run(undoSteps(ctx));
  assert.match(failedAt(result).reason, /off on this deploy/);
});

test('a hold passes on a platform that behaves, and says when owners\' events are unreadable', async () => {
  const { ctx } = contextOf();
  const result = await run(holdSteps(ctx));
  assert.deepEqual(failedAt(result), undefined);
  const audit = result.items.find((i) => i.id === 'H9');
  assert.equal(audit.status, 'skip');
  assert.match(audit.reason, /AUDIT_LOG is off/);
  assert.ok(audit.metrics.operator_events >= 10);
});

for (const [bug, step] of [
  ['deleteUnderHold', 'H3'],
  ['purgeUnderHold', 'H5'],
  ['ownerLiftsOperator', 'H5'],
  ['missingAudit', 'H9'],
  ['leaveR2Key', 'H4'],
])
  test(`a hold fails on ${bug}`, async () => {
    const { ctx } = contextOf({ bugs: { [bug]: true } });
    const result = await run(holdSteps(ctx));
    assert.equal(result.passed, false);
    assert.equal(failedAt(result).id, step, failedAt(result).reason);
  });

test('a lifted hold waits for the sweep, then erases', async () => {
  const { ctx } = contextOf();
  const result = await run(holdWaitSteps(ctx));
  assert.deepEqual(failedAt(result), undefined);
  const hours = result.items.find((i) => i.id === 'W2').metrics.purged_h_after_first_try;
  assert.ok(hours >= 6 && hours < 6.1, `${hours} hours`);
});

const tailOf = (repo, { rows = 300_000, outcome = 'ok', shards = true } = {}) =>
  JSON.stringify({
    outcome,
    logs: [
      ...(shards ? [{ timestamp: 1, message: [JSON.stringify({ event: 'repo.erase', repo: repo.id, phase: 'objects', db_bytes: 500 })] }] : []),
      { timestamp: 2, message: [JSON.stringify({ event: 'repo.erase', repo: repo.id, phase: 'records', rows: 200_000 })] },
      { timestamp: 3, message: [JSON.stringify({ event: 'repo.erase', repo: repo.id, phase: 'erased', rows: rows - 200_000, db_bytes: 40 })] },
    ],
  });

function eraseRun(options, tail = {}) {
  const made = contextOf(options);
  made.ctx.tail = async (repo) => ({ stop: async () => tailOf(repo, tail) });
  made.ctx.asset = async () => ({ status: 200 });
  const rung = { name: 'svelte', query: 'x', path: 'a/b.js' };
  return { ...made, steps: eraseSteps(made.ctx, { rung, checkpoints: ['c1', 'c2'], source: '/src', importMs: 3_600_000, eraseMs: 3_600_000 }) };
}

test('the soak passes, measures, and leaves the Cache API unproven', async () => {
  const { steps } = eraseRun();
  const result = await run(steps);
  assert.deepEqual(failedAt(result), undefined);
  const measured = result.items.find((i) => i.id === 'E6').metrics;
  assert.equal(measured.story.jobs, 2);
  assert.equal(measured.model.usage.erase_jobs, 2);
  assert.ok(measured.model.cost.total_usd > 0);
  const cache = result.items.find((i) => i.id === 'E7');
  assert.equal(cache.status, 'skip');
  assert.match(cache.reason, /Unproven/);
});

test('the soak fails when a copy is left, a job dies or the shards were never cleared', async () => {
  assert.equal(failedAt(await run(eraseRun({ bugs: { leaveR2Key: true } }).steps)).id, 'E5');
  assert.equal(failedAt(await run(eraseRun({}, { outcome: 'exceededCpu' }).steps)).id, 'E6');
  assert.equal(failedAt(await run(eraseRun({}, { shards: false }).steps)).id, 'E6');
});

test('the backfill stops at a failed dry run, and estimates from a good one', async () => {
  const seen = [];
  const ctx = {
    evidence: (name) => seen.push(name),
    backfillDryRun: async () => ({ status: 0, stderr: '', stdout: `dev: 1 objects asked, 0 bytes outside live repositories: {"live": 1}` }),
  };
  assert.equal((await run(backfillSteps(ctx, { delayMs: 1000 }))).passed, true);
  assert.deepEqual(seen, ['backfill-estimate.json']);
  const failing = { ...ctx, backfillDryRun: async () => ({ status: 1, stderr: 'HTTP 500', stdout: '' }) };
  assert.match(failedAt(await run(backfillSteps(failing, { delayMs: 1000 }))).reason, /HTTP 500/);
});

test('clean-up lifts holds, deletes what the run made and nothing else', async () => {
  const { ctx, place } = contextOf();
  const stranger = await ctx.owner.post('/repos', { name: 'oss-cobra' });
  const repo = await newRepo(ctx, 'left', { files: [] });
  await ctx.operator.post(`/admin/repos/${repo.id}/hold`, {});
  assert.deepEqual(await cleanUp(ctx), []);
  assert.ok(place.repos.get(repo.id).erased);
  assert.equal(place.repos.get(stranger.id).deletedAt, null);
});

test('without --go nothing runs and no credential is read', () => {
  const home = mkdtempSync(join(tmpdir(), 'dev-checks-'));
  try {
    const answer = spawnSync(process.execPath, ['tools/staging/dev-checks.mjs'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.equal(answer.status, 0, answer.stderr);
    assert.match(answer.stdout, /Nothing was run/);
    assert.deepEqual(readdirSync(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the tool holds no way to erase tombstones, and never the token-minting credential', () => {
  for (const name of ['dev-checks.mjs', 'dev-checks-backfill.mjs', 'dev-checks-cf.mjs', 'dev-checks-repos.mjs']) {
    const source = readFileSync(new URL(`../../tools/staging/${name}`, import.meta.url), 'utf8');
    assert.ok(!source.includes("'--confirm'"), `${name} sends --confirm`);
    assert.ok(!source.includes('token-admin'), `${name} names token-admin`);
    assert.ok(!/\bprod\.env\b|deploy-prod/.test(source), `${name} names a production credential`);
  }
});
