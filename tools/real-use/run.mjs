// Plays a day: each second, sessions start at the plan's rate for that moment of the day, each on
// its own and with no regard to how the last one went. That is open loop: a slow platform meets
// the same people, as it would in life. It stops at the first of the rules in stop.mjs, judged
// over the last minute by read, write and Git targets.
import { isLimitError, STOP, stopReasons } from '../fanout-bench/stop.mjs';
import { Actor } from './actor.mjs';
import { MIX, randomStream, ratePerMinute, simHour, zipfIndex, ZONES } from './plan.mjs';
import { classOf, SCRIPTS } from './sessions.mjs';

/** Targets from the budget in docs/load-testing.md; a clone is several reads and a pack. */
export const TARGETS = { read: 1000, write: 3000, git: 6000 };
const WINDOW_MS = 60_000;
const MIN_WINDOW_ROWS = 20;

const p95 = (rows) => {
  if (!rows.length) return null;
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
};

/** What many hands on one repository answer in ordinary life: a lost race, a review already
 * given. Each is the platform working, so none counts against it. */
const ORDINARY = new Set(['CONFLICT', 'MERGE_REQUIRED', 'STALE_HEAD', 'STALE_PARENT', 'NOT_READY', 'ALREADY_EXISTS']);
export const refused = (r) => r?.status === 409 && ORDINARY.has(r.error);
/** A failed row: refused for no ordinary reason, unanswered or wrong. */
export const failed = (r) => !r.ok && !refused(r);

/** Stop reasons in `rows` (the last minute), per class, or nothing if too few to judge. */
export function judge(rows) {
  const reasons = [];
  for (const [name, target_ms] of Object.entries(TARGETS)) {
    const own = rows.filter((r) => classOf(r.label) === name);
    if (own.length < MIN_WINDOW_ROWS) continue;
    const errors = own.filter(failed).length;
    const limits = own.filter((r) => isLimitError(`${r.error} ${r.message}`)).length;
    const landed = own.filter((r) => r.ok);
    const hit = stopReasons({ total: own.length, errors, p95_ms: p95(landed), target_ms, limits });
    if (hit.length) reasons.push(`${name}: ${hit.join(', ')} (${errors} of ${own.length} failed, p95 ${p95(landed)} ms, target ${target_ms} ms × ${STOP.p95_factor})`);
  }
  return reasons;
}

/** Runs one day. `population` picks who a session is; `send` reaches a regional client. */
export async function playDay({ plan, population, send, assets, log = () => {}, tickMs = 1000, onRow = () => {}, sideJobs = [], signal }) {
  const random = randomStream(plan.seed);
  const started = Date.now();
  const rows = [];
  const live = new Set();
  const counts = { started: 0, finished: 0, failed_sessions: 0, dropped: 0, by_kind: {}, by_region: {} };
  const kinds = Object.keys(MIX);
  const regions = Object.keys(ZONES);
  const runMs = plan.minutes * 60_000;
  let stopped = null;
  let wake = () => {};
  const ended = new Promise((resolve) => (wake = resolve));
  const stop = (why) => {
    stopped ??= why;
    wake();
  };
  signal?.addEventListener('abort', () => stop('interrupted'));

  const run = {
    send,
    note(row) {
      rows.push(row);
      onRow(row);
    },
    wait: (ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      ended.then(() => {
        clearTimeout(timer);
        resolve();
      });
    }),
  };

  const startSession = (kind, region) => {
    if (live.size >= plan.maxSessions) return void counts.dropped++;
    const who = MIX[kind].who;
    const sessionRandom = randomStream(Math.floor(random() * 2 ** 32));
    const actor = new Actor({ run, kind, region, who, random: sessionRandom, assets, ...population(kind, region, sessionRandom, zipfIndex) });
    counts.started++;
    counts.by_kind[kind] = (counts.by_kind[kind] ?? 0) + 1;
    counts.by_region[region] = (counts.by_region[region] ?? 0) + 1;
    const task = SCRIPTS[kind](actor)
      .catch((e) => {
        counts.failed_sessions++;
        log(`session ${kind} failed: ${String(e?.message ?? e).slice(0, 160)}`);
      })
      .finally(() => {
        counts.finished++;
        live.delete(task);
      });
    live.add(task);
  };

  const jobs = sideJobs.map((job) => job({ wait: run.wait, stopping: () => stopped !== null, note: run.note }));
  const judging = setInterval(() => {
    const since = Date.now() - WINDOW_MS;
    const recent = rows.filter((r) => (r.started_at ?? 0) >= since);
    const reasons = judge(recent);
    if (reasons.length) stop(reasons.join('; '));
    const minute = (Date.now() - started) / 60_000;
    log(`+${minute.toFixed(1)} min, UTC hour ${simHour(minute, plan.minutes, plan.startUtc).toFixed(1)}: ${live.size} sessions, ${recent.length} requests in the last minute, ${recent.filter(failed).length} failed`);
  }, Math.min(WINDOW_MS / 4, Math.max(tickMs * 5, 1000)));

  while (!stopped && Date.now() - started < runMs) {
    const minute = (Date.now() - started) / 60_000;
    const hour = simHour(minute, plan.minutes, plan.startUtc);
    for (const kind of kinds)
      for (const region of regions) {
        const expected = (ratePerMinute(kind, region, hour, plan.peakPerMinute) * tickMs) / 60_000;
        // One tick is well under one arrival, so this is Poisson arrivals, near enough.
        if (random() < expected) startSession(kind, region);
      }
    await new Promise((resolve) => setTimeout(resolve, tickMs));
  }
  clearInterval(judging);
  stop(stopped ?? 'finished');
  const settled = await Promise.race([Promise.all([...live, ...jobs]).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), plan.settleMs ?? 90_000))]);
  return { stopped, rows, counts, ms: Date.now() - started, settled };
}
