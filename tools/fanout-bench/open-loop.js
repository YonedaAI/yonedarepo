// Open-loop arrivals for the sustained landing rate (tools/platform-fanout-bench.mjs
// --workload sustained). This invocation issues `rate` commit-and-land arrivals per second
// for `duration_ms` on its own schedule, whether or not earlier ones have answered, so a
// slow target builds a backlog instead of slowing the load. A Worker invocation keeps at
// most six connections open: arrivals wait for one of `slots`, and each record says how
// long it waited here (the client's own queue, apart from the target's latency).
import { commitAndLand } from './requests.js';

const LIMITS = { rate: 50, duration_ms: 600_000, slots: 6, max_arrivals: 450, timeout_ms: 120_000, drain_ms: 120_000 };

/** Deterministic uniform [0, 1) from a 32-bit seed (mulberry32). */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Arrival offsets (ms) within the window: exponential gaps (Poisson) or a fixed interval. */
export function schedule({ rate, duration_ms, arrivals = 'poisson', seed = 1, max_arrivals = LIMITS.max_arrivals }) {
  const next = random(seed);
  const offsets = [];
  for (let t = 0; offsets.length < max_arrivals; ) {
    t += arrivals === 'fixed' ? 1000 / rate : (-Math.log(1 - next()) * 1000) / rate;
    if (t >= duration_ms) break;
    offsets.push(Math.round(t));
  }
  return offsets;
}

const sleepUntil = (at) => new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now())));

/** Validates the open-loop request; null when it is out of bounds. */
export function parseOpen(open) {
  if (!open || typeof open !== 'object') return null;
  const n = (v, d) => (v === undefined ? d : Number(v));
  const parsed = {
    rate: n(open.rate),
    duration_ms: n(open.duration_ms),
    start_at: n(open.start_at, 0),
    arrivals: open.arrivals ?? 'poisson',
    seed: n(open.seed, 1),
    slots: n(open.slots, LIMITS.slots),
    max_arrivals: n(open.max_arrivals, LIMITS.max_arrivals),
    timeout_ms: n(open.timeout_ms, 30_000),
    drain_ms: n(open.drain_ms, 30_000),
    prefix: String(open.prefix ?? ''),
    token: open.token,
    mode: open.mode,
  };
  const within = (k) => Number.isFinite(parsed[k]) && parsed[k] > 0 && parsed[k] <= LIMITS[k];
  if (!['rate', 'duration_ms', 'slots', 'max_arrivals', 'timeout_ms', 'drain_ms'].every(within)) return null;
  if (!['poisson', 'fixed'].includes(parsed.arrivals) || !/^[a-z0-9/_-]{1,80}$/.test(parsed.prefix)) return null;
  if (typeof parsed.token !== 'string' || !parsed.token) return null;
  return parsed;
}

export async function openLoop(target, repo, open) {
  const offsets = schedule(open);
  const began = Math.max(Date.now(), open.start_at);
  await sleepUntil(began);
  // Arrivals still waiting for a slot after the window and its drain are abandoned, so the
  // invocation answers; in-flight requests end by their timeout.
  const deadline = began + open.duration_ms + open.drain_ms;
  let free = open.slots;
  let maxWaiting = 0;
  const waiting = [];
  const acquire = () => {
    if (free > 0) {
      free--;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      waiting.push(resolve);
      maxWaiting = Math.max(maxWaiting, waiting.length);
    });
  };
  const release = () => {
    for (let next = waiting.shift(); next; next = waiting.shift()) {
      if (Date.now() <= deadline) return next(true);
      next(false);
    }
    free++;
  };
  const results = await Promise.all(
    offsets.map(async (offset, k) => {
      const scheduled_at = began + offset;
      await sleepUntil(scheduled_at);
      const granted = await acquire();
      if (!granted) return { scheduled_at, abandoned: true };
      const queued_ms = Date.now() - scheduled_at;
      try {
        const w = { token: open.token, mode: open.mode, path: `${open.prefix}/${k}.txt`, content: `${open.prefix} ${k}\n` };
        return { scheduled_at, queued_ms, ...(await commitAndLand(target, repo, w, open.timeout_ms)) };
      } finally {
        release();
      }
    }),
  );
  // Drop Server-Timing from commits to keep the answer small; landings keep theirs.
  for (const r of results) if (r.commit) r.commit.timing = undefined;
  return { began_at: began, capped: offsets.length === open.max_arrivals, max_waiting: maxWaiting, results };
}
