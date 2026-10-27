// Sustained landing rate (C4): open-loop arrivals on one repository's main, disjoint files,
// stepping up the offered rate until a step misses. Arrivals are generated in the bench
// client Worker (open-loop.js), split across invocations of `per_shard` lands/s each (one
// repository token per invocation slot) and across segments of at most `segment_s`, so
// no invocation exceeds 1,000 subrequests or outlives the driver's response timeout.
import { schedule } from './open-loop.js';
import { errors, ok, percentiles, phases } from './stats.mjs';

const LEAD_MS = 5000;
const TIMEOUT_MS = 30_000;
const DRAIN_MS = 30_000;
/** A step misses when it achieves under 90% of what it offered, its p95 exceeds 5 s, or
 * more than 1% of its arrivals are refused. */
export const MISS = { achieved: 0.9, p95_ms: 5000, refusals: 0.01 };

/** Platform requests (a commit and a land per arrival, plus the tokens) and the longest
 * runtime of the planned steps. */
export function estimate({ rates, step_s, per_shard }) {
  const shards = Math.max(...rates.map((r) => Math.ceil(r / per_shard)));
  const requests = rates.reduce((n, r) => n + Math.round(r * step_s * 2), 0) + shards + 2;
  const runtime = rates.length * (step_s + (LEAD_MS + TIMEOUT_MS + DRAIN_MS) / 1000);
  return { requests, max_shards: shards, max_runtime_s: runtime };
}

const finished = (r) => {
  const last = r.land ?? r.commit;
  return last ? last.started_at + last.ms : null;
};
const failure = (r) => (ok(r.commit) ? r.land : r.commit);

/** One step's figures from its arrival records (bench client clock). */
export function summarizeStep(records, { rate, duration_ms, warmup_ms, window_start }) {
  const end = window_start + duration_ms;
  const from = window_start + Math.min(warmup_ms, duration_ms / 2);
  const landed = records.filter((r) => ok(r.land));
  const inWindow = landed.filter((r) => finished(r) >= from && finished(r) <= end).length;
  const offered = (records.length * 1000) / duration_ms;
  const achieved = (inWindow * 1000) / (end - from);
  const abandoned = records.filter((r) => r.abandoned);
  const refused = records.filter((r) => !r.abandoned && !ok(r.land));
  const byCode = {};
  for (const r of refused) {
    const f = failure(r);
    const key = `${f.status} ${f.error ?? ''}`.trim();
    byCode[key] = (byCode[key] ?? 0) + 1;
  }
  // Arrivals issued and not yet answered, sampled each second (abandoned ones never are).
  const last = records.reduce((m, r) => Math.max(m, finished(r) ?? 0), end);
  const backlog = [];
  for (let t = window_start; t <= last; t += 1000)
    backlog.push(records.filter((r) => r.scheduled_at <= t && !((finished(r) ?? Infinity) <= t)).length);
  const latency = percentiles(landed.map((r) => finished(r) - r.scheduled_at));
  const queued = percentiles(records.filter((r) => !r.abandoned).map((r) => r.queued_ms));
  const refusalRate = records.length ? refused.length / records.length : 0;
  const missed = [
    achieved < MISS.achieved * offered && 'achieved',
    (latency.p95_ms ?? Infinity) > MISS.p95_ms && 'p95',
    refusalRate > MISS.refusals && 'refusals',
  ].filter(Boolean);
  return {
    rate,
    arrivals: records.length,
    offered_per_second: Number(offered.toFixed(1)),
    achieved_per_second: Number(achieved.toFixed(1)),
    landed: landed.length,
    refused: refused.length,
    refusal_rate: Number(refusalRate.toFixed(4)),
    refusals: byCode,
    errors: errors(refused.map(failure)).slice(0, 10),
    latency,
    commit: percentiles(records.filter((r) => ok(r.commit)).map((r) => r.commit.ms)),
    land: percentiles(landed.map((r) => r.land.ms)),
    land_phases: phases(landed.map((r) => r.land)),
    backlog: { max: Math.max(0, ...backlog), at_window_end: backlog[Math.floor(duration_ms / 1000)] ?? 0, drain_ms: Math.max(0, last - end) },
    // The bench client's own queue: if it waits, raise the invocation count (lower
    // --per-shard) before reading the knee.
    client: { queued: queued, abandoned: abandoned.length, limited: abandoned.length > 0 || (queued.p95_ms ?? 0) > 1000 },
    missed,
  };
}

async function step(session, repo, tokens, o, index) {
  const shards = Math.ceil(o.rate / o.per_shard);
  const segments = Math.ceil(o.step_s / o.segment_s);
  const segmentMs = (o.step_s * 1000) / segments;
  const start = Date.now() + LEAD_MS;
  const calls = [];
  for (let j = 0; j < segments; j++)
    for (let s = 0; s < shards; s++) {
      const open = {
        rate: o.rate / shards,
        duration_ms: segmentMs,
        start_at: start + j * segmentMs,
        arrivals: o.arrivals,
        seed: (index + 1) * 1_000_000 + j * 1000 + s,
        prefix: `load/r${o.rate}/s${s}/g${j}`,
        token: tokens[s],
        mode: o.mode,
        timeout_ms: TIMEOUT_MS,
        drain_ms: DRAIN_MS,
      };
      calls.push(
        (async () => {
          await new Promise((r) => setTimeout(r, Math.max(0, open.start_at - LEAD_MS - Date.now())));
          const reply = await session.invoke({ repo, open });
          // An invocation that failed outright loses its whole schedule: abandoned arrivals.
          if (reply.failed)
            return { segment: j, began_at: open.start_at, capped: false, max_waiting: 0, results: schedule(open).map((t) => ({ scheduled_at: open.start_at + t, abandoned: true, client_error: reply.failed })) };
          return { segment: j, ...reply };
        })(),
      );
    }
  const replies = await Promise.all(calls);
  const records = replies.flatMap((r) => r.results);
  const windowStart = Math.min(...replies.filter((r) => r.segment === 0).map((r) => r.began_at));
  return {
    shards,
    segments,
    capped_invocations: replies.filter((r) => r.capped).length,
    failed_invocations: replies.filter((r) => r.results.some((x) => x.client_error)).length,
    max_client_waiting: Math.max(...replies.map((r) => r.max_waiting)),
    ...summarizeStep(records, { rate: o.rate, duration_ms: o.step_s * 1000, warmup_ms: o.warmup_s * 1000, window_start: windowStart }),
  };
}

export async function sustained(session, o) {
  const repo = await session.createRepo('sustained', [{ path: 'README.md', content_b64: Buffer.from('sustained landing rate\n').toString('base64') }]);
  const tokens = await session.mintTokens(repo, estimate(o).max_shards);
  const steps = [];
  let knee = null;
  for (const [index, rate] of o.rates.entries()) {
    const result = await step(session, repo, tokens, { ...o, rate }, index);
    steps.push(result);
    console.error(`step ${rate}/s: achieved ${result.achieved_per_second}/s, p95 ${result.latency.p95_ms} ms, refused ${result.refused}${result.missed.length ? `, missed: ${result.missed.join(', ')}` : ''}${result.client.limited ? ' (bench client limited)' : ''}`);
    if (result.missed.length) {
      knee = rate;
      break;
    }
  }
  const sustainedRates = steps.filter((s) => !s.missed.length).map((s) => s.rate);
  return {
    repo,
    rates: o.rates,
    step_s: o.step_s,
    per_shard: o.per_shard,
    arrivals: o.arrivals,
    mode: o.mode ?? 'default',
    miss_rule: MISS,
    knee,
    last_sustained: sustainedRates.at(-1) ?? null,
    steps,
  };
}
