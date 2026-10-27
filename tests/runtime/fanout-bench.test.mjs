import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOpen, schedule } from '../../tools/fanout-bench/open-loop.js';
import { loggedReads, overlaps, violations } from '../../tools/fanout-bench/skew.mjs';
import { estimate, summarizeStep } from '../../tools/fanout-bench/sustained.mjs';

const MAIN = 'refs/heads/main';
const entry = (version, paths, extra = {}) => ({ version, base_version: version - 1, kind: 'changeset', refname: MAIN, paths: paths.map((path) => ({ path })), read_set: [], ...extra });

test('overlaps matches the platform rule: equal paths and directory prefixes', () => {
  assert.ok(overlaps('a/b.txt', 'a/b.txt'));
  assert.ok(overlaps('a/', 'a/b.txt'));
  assert.ok(overlaps('a', 'a/b.txt'));
  assert.ok(overlaps('a/b.txt', 'a'));
  assert.ok(!overlaps('a/b.txt', 'a/bc.txt'));
  assert.ok(!overlaps('ab', 'a/b'));
});

test('a write landed inside a reader window on a path it read is a violation', () => {
  const entries = [entry(5, ['x/1.txt']), entry(6, ['x/2.txt']), entry(7, ['x/3.txt'])];
  const reader = { commit: 'c', base_version: 4, version: 7, read_set: ['x/2.txt'] };
  assert.deepEqual(violations([reader], entries), [{ commit: 'c', base_version: 4, version: 7, by_version: 6, paths: ['x/2.txt'] }]);
});

test('writes outside the window, at the reader own version, or on other refs are not violations', () => {
  const entries = [entry(4, ['x/2.txt']), entry(7, ['x/2.txt']), entry(8, ['x/2.txt']), entry(6, ['x/2.txt'], { refname: 'refs/heads/topic' })];
  assert.deepEqual(violations([{ commit: 'c', base_version: 4, version: 7, read_set: ['x/2.txt'] }], entries), []);
  assert.deepEqual(violations([{ commit: 'c', base_version: 4, version: 7, read_set: [] }], [entry(5, ['x/2.txt'])]), []);
});

test('directory reads, symbol reads and ref moves without paths are checked conservatively', () => {
  const window = { commit: 'c', base_version: 1, version: 3 };
  assert.equal(violations([{ ...window, read_set: ['x/'] }], [entry(2, ['x/9.txt'])]).length, 1);
  // A symbol read counts as its whole file here (stricter than the platform).
  assert.equal(violations([{ ...window, read_set: ['x/1.rs#f'] }], [entry(2, ['x/1.rs'])]).length, 1);
  assert.deepEqual(violations([{ ...window, read_set: ['x/1.rs'] }], [entry(2, [], { kind: 'reset' })])[0].paths, ['(ref move without paths)']);
  assert.deepEqual(violations([{ ...window, read_set: ['x/1.rs'] }], [entry(2, [], { kind: 'commit' })]), []);
});

test('the log view checks each entry against its own recorded base and reads', () => {
  const entries = [entry(2, ['b.txt']), entry(3, ['a.txt'], { base_version: 1, read_set: ['b.txt'], new: 'n3' })];
  assert.deepEqual(loggedReads(entries), [{ commit: 'n3', base_version: 1, version: 3, read_set: ['b.txt'] }]);
  assert.equal(violations(loggedReads(entries), entries).length, 1);
});

const T0 = 1_000_000;
/** Arrivals every `gap` ms for `duration` ms; each lands after `latency(k)` ms. */
function arrivals({ gap, duration, latency, status = () => 200 }) {
  const out = [];
  for (let k = 0, t = T0; t < T0 + duration; k++, t += gap) {
    const ms = latency(k);
    const commit = { started_at: t, ms: ms / 2, status: 200 };
    const land = { started_at: t + ms / 2, ms: ms / 2, status: status(k), error: status(k) === 200 ? undefined : 'RATE_LIMITED' };
    out.push({ scheduled_at: t, queued_ms: 0, commit, land });
  }
  return out;
}
const options = { rate: 10, duration_ms: 60_000, warmup_ms: 5000, window_start: T0 };

test('a step that keeps up achieves its offered rate and misses nothing', () => {
  const step = summarizeStep(arrivals({ gap: 100, duration: 60_000, latency: () => 300 }), options);
  assert.equal(step.arrivals, 600);
  assert.equal(step.offered_per_second, 10);
  assert.ok(Math.abs(step.achieved_per_second - 10) <= 0.2, `achieved ${step.achieved_per_second}`);
  assert.equal(step.latency.p95_ms, 300);
  assert.deepEqual(step.missed, []);
  assert.ok(step.backlog.max <= 4);
  assert.equal(step.client.limited, false);
});

test('a step whose backlog grows misses on achieved rate and p95', () => {
  // Service time 150 ms per landing, one at a time: at most 6.7/s against 10/s offered.
  const step = summarizeStep(arrivals({ gap: 100, duration: 60_000, latency: (k) => 150 * (k + 1) - 100 * k }), options);
  assert.ok(step.achieved_per_second < 9, `achieved ${step.achieved_per_second}`);
  assert.deepEqual(step.missed, ['achieved', 'p95']);
  assert.ok(step.backlog.at_window_end > 100);
});

test('more than 1% refused arrivals is a miss, counted by code', () => {
  const step = summarizeStep(arrivals({ gap: 100, duration: 60_000, latency: () => 300, status: (k) => (k % 50 === 0 ? 429 : 200) }), options);
  assert.equal(step.refused, 12);
  assert.deepEqual(step.refusals, { '429 RATE_LIMITED': 12 });
  assert.ok(step.missed.includes('refusals'));
});

test('arrivals the bench client abandoned mark the step client-limited', () => {
  const records = arrivals({ gap: 100, duration: 60_000, latency: () => 300 });
  records.push({ scheduled_at: T0 + 59_000, abandoned: true });
  const step = summarizeStep(records, options);
  assert.equal(step.client.abandoned, 1);
  assert.equal(step.client.limited, true);
  assert.equal(step.refused, 0);
});

test('schedules are deterministic, capped, and fixed or Poisson', () => {
  assert.deepEqual(schedule({ rate: 2, duration_ms: 3000, arrivals: 'fixed' }), [500, 1000, 1500, 2000, 2500]);
  const poisson = schedule({ rate: 5, duration_ms: 60_000, seed: 7 });
  assert.deepEqual(poisson, schedule({ rate: 5, duration_ms: 60_000, seed: 7 }));
  assert.ok(Math.abs(poisson.length - 300) < 60, `${poisson.length} arrivals`);
  assert.ok(poisson.every((t, i) => t < 60_000 && (i === 0 || t >= poisson[i - 1])));
  assert.equal(schedule({ rate: 50, duration_ms: 600_000, max_arrivals: 450 }).length, 450);
});

test('open-loop requests out of bounds are refused', () => {
  const good = { rate: 1, duration_ms: 120_000, prefix: 'load/r1/s0/g0', token: 'yrp_x' };
  assert.ok(parseOpen(good));
  assert.equal(parseOpen({ ...good, rate: 51 }), null);
  assert.equal(parseOpen({ ...good, duration_ms: 0 }), null);
  assert.equal(parseOpen({ ...good, prefix: '../x' }), null);
  assert.equal(parseOpen({ ...good, token: undefined }), null);
  assert.equal(parseOpen({ ...good, arrivals: 'burst' }), null);
});

test('the estimate counts a commit and a land per arrival, plus tokens', () => {
  const planned = estimate({ rates: [50, 100, 200, 400, 800], step_s: 120, per_shard: 1 });
  assert.equal(planned.requests, 1550 * 120 * 2 + 800 + 2);
  assert.equal(planned.max_shards, 800);
  assert.ok(estimate({ rates: [50, 100, 200, 400, 800], step_s: 600, per_shard: 1 }).requests < 2_000_000);
  assert.ok(estimate({ rates: [50, 100, 200, 400, 800, 1600], step_s: 600, per_shard: 1 }).requests > 2_000_000);
});
