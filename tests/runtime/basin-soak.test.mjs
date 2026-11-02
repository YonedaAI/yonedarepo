// The Basin soak: how the table is held to the log, what a day costs and what prod's gates ask.
// No network: stand-ins for the log and the table, and real SQLite for the landing rule.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareRepo, hasTrouble, settledVersion, summarize, windowOf } from '../../tools/basin-soak/compare.mjs';
import { dayCost, daily, metricReaders, operationsByClass, perRecord, PRICES, queryTexts } from '../../tools/basin-soak/cost.mjs';
import { BY_HAND, GATES, judgeGates } from '../../tools/basin-soak/gates.mjs';
import { LANDING } from '../../tools/basin-soak/landing.mjs';

const tool = fileURLToPath(new URL('../../tools/platform-basin-soak.mjs', import.meta.url));
const entry = (version, kind = 'changeset', extra = {}) => ({ version, kind, new: `c${version}`, committed_at_ms: 1000 * version, ...extra });
const land = (version, kind = 'changeset', extra = {}) => ({ event: 'land', version, kind, commit: `c${version}`, merged_landings: 0, ...extra });
const merged = (version, commit) => ({ event: 'merged', version, commit, merged_landings: 0 });
const window = { from: 0, until: 5 };

test('a table that matches the log has no drift, whatever the versions were', () => {
  const entries = [entry(1, 'import'), entry(2), entry(3, 'commit'), entry(4, 'ref_move'), entry(5, 'revert')];
  const rows = entries.map((e) => land(e.version, e.kind));
  const result = compareRepo({ entries, rows, window });
  assert.deepEqual([result.log_versions, result.log_landings, result.basin_landings, result.drift], [5, 3, 3, 0]);
  assert.ok(!hasTrouble(result));
});

test('the comparison counts landings as the SQL rule does, on real rows', () => {
  const entries = [entry(1, 'import'), entry(2), entry(3, 'merge'), entry(4, 'ref_delete'), entry(5, 'merge')];
  const rows = [land(1, 'import'), land(2), land(3, 'merge', { merged_landings: 2 }), merged(3, 'a'), merged(3, 'b'), land(4, 'ref_delete'), land(5, 'merge')];
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE changes(event TEXT, kind TEXT, merged_landings INTEGER)');
  for (const r of rows) db.prepare('INSERT INTO changes VALUES(?,?,?)').run(r.event, r.kind ?? null, r.merged_landings);
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE ${LANDING}`).get();
  const result = compareRepo({ entries, rows, window });
  assert.equal(result.basin_landings, n);
  assert.equal(result.log_landings, n);
  assert.equal(n, 4);
});

test('a version the table lost is named and counts as drift', () => {
  const entries = [entry(1), entry(2), entry(3)];
  const result = compareRepo({ entries, rows: [land(1), land(3)], window });
  assert.deepEqual(result.missing, [2]);
  assert.equal(result.drift, 1);
  assert.ok(hasTrouble(result));
});

test('a row the log never held, a wrong commit and a lost merge row are each named', () => {
  const entries = [entry(1), entry(2), entry(3, 'merge')];
  const rows = [land(1), land(2, 'changeset', { commit: 'other' }), land(3, 'merge', { merged_landings: 2 }), merged(3, 'a'), land(4)];
  const result = compareRepo({ entries, rows, window });
  assert.deepEqual([result.extra, result.wrong, result.merged_wrong], [[4], [2], [3]]);
  assert.ok(hasTrouble(result));
});

test('a duplicate send is at least once: named, and no drift', () => {
  const result = compareRepo({ entries: [entry(1)], rows: [land(1), land(1)], window });
  assert.deepEqual(result.duplicates, [1]);
  assert.equal(result.drift, 0);
  assert.ok(!hasTrouble(result));
});

test('a window starts after what the stream decided to skip and stops at what has settled', () => {
  const rows = [land(3), land(4), land(40), land(41)];
  assert.deepEqual(windowOf({ rows, cursor: { version: 50 }, headOfLog: 60, settledBefore: 45 }), { from: 2, until: 45 });
  assert.deepEqual(windowOf({ rows, cursor: { version: 50, last_gap: { to: 39 } }, headOfLog: 60, settledBefore: 60 }), { from: 39, until: 50 });
  assert.equal(windowOf({ rows: [], cursor: { version: 50 } }), null);
  assert.equal(windowOf({ rows, cursor: null }), null);
  assert.equal(windowOf({ rows, cursor: { version: 50 }, settledBefore: 2 }), null);
  assert.equal(settledVersion([entry(1), entry(2), entry(3)], 2500), 2);
});

test('a check passes only on enough landings, and any trouble fails it', () => {
  const fine = compareRepo({ entries: [entry(1), entry(2)], rows: [land(1), land(2)], window });
  const repos = [{ repo: 'a', cursor: { gaps: 1, failures: 2 }, ...fine }, { repo: 'b', window: null }];
  assert.equal(summarize(repos, { minLandings: 2 }).verdict, 'pass');
  assert.deepEqual(summarize(repos, { minLandings: 2 }).gaps, 1);
  assert.equal(summarize(repos, { minLandings: 3 }).verdict, 'too_few');
  assert.equal(summarize([{ repo: 'c', window: null, sent_without_rows: true }], { minLandings: 0 }).verdict, 'fail');
  const lost = compareRepo({ entries: [entry(1)], rows: [land(1, 'commit')], window });
  const failing = summarize([{ repo: 'd', ...lost }], { minLandings: 0 });
  assert.deepEqual([failing.verdict, failing.trouble], ['fail', ['d']]);
  assert.equal(summarize([], { minLandings: 1 }).drift_pct, null);
});

test('days hold only our pipeline, and dropped events are counted beside what was delivered', () => {
  const dim = (date, pipelineId) => ({ date, pipelineId });
  const days = daily(
    [{ dimensions: dim('2026-11-01', 'p1'), sum: { recordsIn: 10, bytesIn: 1000, decodeErrors: 1 } }, { dimensions: dim('2026-11-01', 'p2'), sum: { recordsIn: 99, bytesIn: 9e9, decodeErrors: 9 } }],
    [{ dimensions: dim('2026-11-01', 'p1'), sum: { recordsWritten: 10, uncompressedBytesWritten: 2500, bytesWritten: 500, filesWritten: 2 } }],
    [{ dimensions: dim('2026-11-01', 'p1'), count: 3 }],
    'p1',
  );
  assert.deepEqual(days, [{ date: '2026-11-01', records_in: 10, bytes_in: 1000, decode_errors: 1, records_written: 10, uncompressed_bytes: 2500, bytes_written: 500, files: 2, dropped: 3 }]);
  assert.equal(perRecord(days), 250);
  assert.equal(perRecord([]), null);
});

test('a day costs what the price list says, and a month takes off what is included', () => {
  const day = { date: 'd', bytes_in: 2e9, uncompressed_bytes: 3e9 };
  const cost = dayCost(day, { stored_bytes: 30e9, class_a: 2e6, class_b: 1e6, days_of_operations: 2, queries_gb_day: 4 });
  assert.deepEqual(cost.list_usd, { sql_transform: 0.08, sink: 0.18, r2_storage: 0.015, r2_class_a: 4.5, r2_class_b: 0.18, basin_sql: 0.01 });
  assert.equal(cost.list_total_usd, 4.965);
  // 90 GB sunk at 40 over, 60 GB through SQL at 10 over, 120 GB scanned at 110 over, R2 in full.
  assert.equal(cost.month_after_included_usd, Number((10 * 0.04 + 40 * 0.06 + 110 * 0.0025 + 30 * 4.695).toFixed(4)));
  assert.match(cost.not_counted[0], /catalog operations/);
  assert.equal(PRICES.checked, '2026-11-01');
  assert.deepEqual(operationsByClass([{ dimensions: { actionType: 'PutObject' }, sum: { requests: 5 } }, { dimensions: { actionType: 'GetObject' }, sum: { requests: 7 } }]), { class_a: 5, class_b: 7 });
});

test('a metric source that fails says so, and every query only reads', async () => {
  for (const text of queryTexts()) assert.match(text, /^query /);
  const readers = metricReaders({ token: 't', account: 'a', bucket: 'b', fetchImpl: async () => new Response('{"errors":[{"message":"no"}]}', { status: 200 }) });
  await assert.rejects(readers.sink({ start: 0, end: 1 }), /sink: HTTP 200 no/);
  const fine = metricReaders({ token: 't', account: 'a', bucket: 'b', fetchImpl: async () => Response.json({ data: { viewer: { accounts: [{ rows: [1] }] } } }) });
  assert.deepEqual(await fine.stored({ start: 0, end: 1 }), [1]);
});

const check = (date, summary = {}, metrics = {}) => ({
  checked_at: `${date}T09:00:00Z`,
  summary: { verdict: 'pass', landings_in_log: GATES.landings, repositories_compared: GATES.repositories, ...summary },
  metrics: { dropped_total: 0, unreadable: {}, month_after_included_usd: 1, ...metrics },
});
const held = (gates) => gates.filter((g) => !g.passed).map((g) => g.name);

test('prod waits for every gate, and a day that failed or could not be read holds it', () => {
  const week = Array.from({ length: 7 }, (_, i) => check(`2026-11-0${i + 1}`));
  assert.deepEqual(held(judgeGates(week)), []);
  assert.match(held(judgeGates(week.slice(1)))[0], /7 days/);
  assert.match(held(judgeGates([...week, check('2026-11-08', { verdict: 'fail' })]))[0], /No check failed/);
  assert.match(held(judgeGates([...week, check('2026-11-08', {}, { dropped_total: 1 })]))[0], /No event dropped/);
  assert.deepEqual(held(judgeGates([...week, check('2026-11-08', {}, { unreadable: { sink: 'no' } })])).length, 2);
  assert.match(held(judgeGates([...week, check('2026-11-08', {}, { month_after_included_usd: GATES.cost_month_usd })])).at(-1), /a month/);
  assert.equal(held(judgeGates([])).length, 4);
  assert.ok(BY_HAND.some((item) => /privacy/.test(item)));
});

test('a dry run says what it reads, nothing runs without --yes, and prod is refused', () => {
  const dry = spawnSync('node', [tool, '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stderr, /Reads only/);
  assert.notEqual(spawnSync('node', [tool], { encoding: 'utf8' }).status, 0);
  assert.match(spawnSync('node', [tool, '--dry-run', '--url', 'https://api.yonedarepo.com'], { encoding: 'utf8' }).stderr, /dev only/);
});
