// Statistics over the bench client's per-request records (tools/platform-fanout-bench.mjs).
// A record is `{started_at, status, ms, server, timing, error, message}` as requests.js
// reports it.
import { latency } from '../load-metrics.mjs';

export const ok = (r) => r?.status === 200;
export const stat = (rows, key) => latency(rows.filter((r) => ok(r) && r[key] !== null).map((r) => r[key]));

/** p50/p95/p99/max of `values` (nearest rank). */
export function percentiles(values) {
  if (!values.length) return { samples: 0, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return { samples: sorted.length, p50_ms: at(0.5), p95_ms: at(0.95), p99_ms: at(0.99), max_ms: sorted.at(-1) };
}

/** Failed records counted by `<status> <code>: <message>`. */
export function errors(rows) {
  const counts = {};
  for (const r of rows.filter((r) => r && !ok(r))) {
    const key = `${r.status} ${r.error}: ${r.message ?? ''}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts);
}

/** Per Server-Timing phase: latency of its total across requests. */
export function phases(rows, failed = false) {
  const all = {};
  for (const r of rows.filter((r) => r && (failed || ok(r))))
    for (const part of (r.timing ?? '').split(',').filter(Boolean)) {
      const [name, dur, desc] = part.trim().split(';');
      (all[name] ??= []).push(Number(dur?.slice(4)));
      // The count a phase covered (its desc), e.g. a land batch's size.
      if (name === 'land.batch') (all[`${name}.size`] ??= []).push(Number(desc?.match(/\d+/)?.[0]));
    }
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, latency(v)]));
}

/** The most landings answered within any one second (throughput while work is queued,
 * apart from how fast the load generator sends it). */
export function landPeak(rows) {
  const ends = rows.filter(ok).map((r) => r.started_at + r.ms).sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; j < ends.length; j++) {
    while (ends[j] - ends[i] >= 1000) i++;
    best = Math.max(best, j - i + 1);
  }
  return best;
}

/** Successful landings per second, from the first landing request to the last answer. */
export function landRate(rows) {
  const done = rows.filter(ok);
  if (!done.length) return 0;
  const first = Math.min(...done.map((r) => r.started_at));
  const last = Math.max(...done.map((r) => r.started_at + r.ms));
  return Number(((done.length * 1000) / Math.max(1, last - first)).toFixed(1));
}

/** Commits per commit shard (the platform writes a commit to shard id[0..2] % 64). */
export function shardLoad(rows) {
  const counts = new Array(64).fill(0);
  for (const r of rows.filter(ok)) if (r.commit) counts[Number.parseInt(r.commit.slice(0, 2), 16) % 64]++;
  const sorted = [...counts].sort((a, b) => a - b);
  return { shards: 64, min: sorted[0], median: sorted[32], max: sorted[63] };
}
