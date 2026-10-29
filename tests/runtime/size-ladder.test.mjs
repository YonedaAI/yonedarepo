import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregate,
  done,
  markdownTable,
  mergePhases,
  parseCurlTrace,
  parseServerTiming,
  parseTimingLine,
  planCheckpoints,
  record,
  requestCounts,
  stats,
} from '../../tools/staging/size-ladder-lib.mjs';

test('Server-Timing phases carry durations and counts, repeated names summed', () => {
  const phases = parseServerTiming(
    'total;dur=812.4;desc="1", bundle.read;dur=300.5;desc="12", do.bundle_locate;dur=40;desc="2", bundle.read;dur=10;desc="3", odd',
  );
  assert.deepEqual(phases['bundle.read'], { ms: 310.5, n: 15 });
  assert.deepEqual(phases['do.bundle_locate'], { ms: 40, n: 2 });
  assert.deepEqual(phases.odd, { ms: 0, n: 1 });
  assert.deepEqual(parseServerTiming(''), {});
  assert.deepEqual(requestCounts(phases), { do_calls: 2, r2_reads: 15 });
  assert.deepEqual(mergePhases([phases, { 'bundle.read': { ms: 1, n: 1 } }])['bundle.read'], { ms: 311.5, n: 16 });
});

test('the fetch timing line parses into numbers without units', () => {
  const line =
    'remote: yoneda-timing cache=hit walk=262ms entries=7270 deltas=1458 raw=168.1MiB sent=32.4MiB walk_reads=5 reads=55 read=168.2MiB bundles=37 read_wait=4881ms stream=8419ms';
  assert.deepEqual(parseTimingLine(line), {
    cache: 'hit',
    walk: 262,
    entries: 7270,
    deltas: 1458,
    raw: 168.1,
    sent: 32.4,
    walk_reads: 5,
    reads: 55,
    read: 168.2,
    bundles: 37,
    read_wait: 4881,
    stream: 8419,
  });
  assert.deepEqual(parseTimingLine('no timing here'), {});
});

test('a curl trace yields each request with its Server-Timing', () => {
  const trace = [
    '12:00:00.0 => Send header: GET /git/r1.git/info/refs?service=git-upload-pack HTTP/2',
    '12:00:00.1 <= Recv header: server-timing: git.auth;dur=3',
    '12:00:00.2 => Send header: POST /git/r1.git/git-upload-pack HTTP/2',
    '12:00:00.3 <= Recv header: Server-Timing: total;dur=900',
  ].join('\n');
  assert.deepEqual(parseCurlTrace(trace), [
    { request: 'GET /git/r1.git/info/refs', timing: 'git.auth;dur=3' },
    { request: 'POST /git/r1.git/git-upload-pack', timing: 'total;dur=900' },
  ]);
});

test('min, median and max ignore missing values', () => {
  assert.deepEqual(stats([3, 1, null, 2]), { n: 3, min: 1, median: 2, max: 3 });
  assert.deepEqual(stats([4, 1, 3, 2]), { n: 4, min: 1, median: 2.5, max: 4 });
  assert.deepEqual(stats([undefined, Number.NaN]), { n: 0, min: null, median: null, max: null });
});

test('runs aggregate per rung and op over the passing ones, errors kept apart', () => {
  const results = [
    { rung: 'small', op: 'clone', run: 1, ok: true, wall_ms: 900, metrics: { sent: 10, read_wait: 5 } },
    { rung: 'small', op: 'clone', run: 2, ok: true, wall_ms: 700, metrics: { sent: 12 } },
    { rung: 'small', op: 'clone', run: 3, ok: false, wall_ms: 50, error: 'ERR too many objects', metrics: { sent: 99 } },
    { rung: 'small', op: 'search', run: 1, ok: false, error: 'timeout' },
  ];
  const [clone, search] = aggregate(results);
  assert.equal(clone.runs, 3);
  assert.equal(clone.ok, 2);
  assert.deepEqual(clone.wall_ms, { n: 2, min: 700, median: 800, max: 900 });
  assert.deepEqual(clone.metrics.sent, { n: 2, min: 10, median: 11, max: 12 });
  assert.deepEqual(clone.metrics.read_wait, { n: 1, min: 5, median: 5, max: 5 });
  assert.deepEqual(clone.errors, ['ERR too many objects']);
  assert.deepEqual([search.ok, search.errors, search.wall_ms.n], [0, ['timeout'], 0]);

  const ladder = { rungs: [{ name: 'small', source: 'https://example.test/s.git', commit: 'a'.repeat(40), expect: ['clone refused'] }] };
  const table = markdownTable([search, clone], ladder);
  assert.match(table, /\| small \| clone \| 2\/3 \| 700 \/ 800 \/ 900 \| 10\.0 \/ 11\.0 \/ 12\.0 \|/);
  assert.ok(table.indexOf('| small | clone |') < table.indexOf('| small | search |'));
  assert.match(table, /\| small \| https:\/\/example\.test\/s\.git @ aaaaaaaaaaaa \| clone refused \|/);
});

test('import pushes are the furthest first-parent commits within the limits', async () => {
  // Objects each first-parent commit adds; one step (index 6) is over the limit by itself.
  const adds = [5, 5, 5, 5, 5, 5, 40, 5, 5, 5, 5, 5, 5];
  let probes = 0;
  const cost = async (from, to) => {
    probes++;
    const objects = adds.slice(from + 1, to + 1).reduce((n, a) => n + a, 0);
    return { objects, bytes: objects * 100 };
  };
  const limits = { objects: 20, bytes: 1e9 };
  const checkpoints = await planCheckpoints(adds.length, cost, limits);
  assert.deepEqual(checkpoints, [3, 5, 6, 10, 12]);
  // Each push but the oversized step fits, and the next commit would not have.
  let from = -1;
  for (const to of checkpoints) {
    const { objects } = await cost(from, to);
    if (to !== 6) assert.ok(objects <= 20);
    if (to !== 6 && to < adds.length - 1) assert.ok((await cost(from, to + 1)).objects > 20);
    from = to;
  }
  assert.ok(probes < 60, `${probes} probes`);
  // A history within the limits is one push; bytes limit too.
  assert.deepEqual(await planCheckpoints(3, async () => ({ objects: 1, bytes: 1 }), limits), [2]);
  assert.deepEqual(await planCheckpoints(4, cost, { objects: 1e9, bytes: 1000 }), [1, 3]);
});

test('finished results are skipped on resume, failed ones retried', () => {
  const state = { results: [] };
  record(state, { rung: 'a', op: 'clone', run: 1, ok: false, error: 'x' });
  assert.equal(done(state, 'a', 'clone', 1), false);
  assert.equal(done(state, 'a', 'clone', 1, true), true);
  record(state, { rung: 'a', op: 'clone', run: 1, ok: true });
  assert.equal(state.results.length, 1);
  assert.equal(done(state, 'a', 'clone', 1), true);
  assert.equal(done(state, 'a', 'clone', 2), false);
});
