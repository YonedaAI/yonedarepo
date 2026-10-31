// Sustained landing rate (C4): open-loop arrivals on the main of one or more repositories,
// disjoint files, stepping up the offered rate (per repository) until a step misses. Arrivals
// are generated in the bench client Worker (open-loop.js), split across invocations of
// `per_shard` lands/s each (one credential per invocation slot) and across segments of at most
// `segment_s`, so no invocation exceeds 1,000 subrequests or outlives the driver's response
// timeout. The stop rules (stop.mjs) are checked as each segment comes back, so a long run ends
// within two segments of breaking; the sampler watches the server meanwhile.
import { runId, writerCredentials } from './credentials.mjs';
import { schedule } from './open-loop.js';
import { sampled } from './sampler.mjs';
import { errors, ok, percentiles, phases } from './stats.mjs';
import { d1Errors, expectedConflict, limitErrors, STOP, stopReasons, TARGETS } from './stop.mjs';

const LEAD_MS = 5000;
const TIMEOUT_MS = 30_000;
const DRAIN_MS = 30_000;
/** A step misses when it trips a stop rule, or achieves under 90% of what it offered: open-loop
 * load that is not landing is not sustained, whatever the answers say. */
export const MISS = { achieved: 0.9, ...STOP };
/** Top-level directories of the `spread` layout. */
export const DIRS = 32;

/** Platform requests (a commit and a land per arrival, plus the credentials) and the longest
 * runtime of the planned steps. `max_shards` is per repository; `rates` are too. */
export function estimate({ rates, step_s, per_shard, repo_count = 1 }) {
  const shards = Math.max(...rates.map((r) => Math.ceil(r / per_shard)));
  const requests = rates.reduce((n, r) => n + Math.round(r * step_s * 2), 0) * repo_count + shards * repo_count + 2;
  const runtime = rates.length * (step_s + (LEAD_MS + TIMEOUT_MS + DRAIN_MS) / 1000);
  return { requests, max_shards: shards, max_runtime_s: runtime };
}

/** Where one invocation writes, unique to the run. `single` puts every write in one search
 * partition (a top-level directory), so each derive job rebuilds it, a finding worth measuring;
 * `spread` moves across DIRS partitions by shard and segment, as a real repository's writes do. */
export function pathPrefix({ layout, dirs = DIRS, run, rate, shard, segment }) {
  const top = layout === 'single' ? 'load' : `d${(shard + segment) % dirs}`;
  return `${top}/${run}/r${rate}/s${shard}/g${segment}`;
}

const finished = (r) => {
  const last = r.land ?? r.commit;
  return last ? last.started_at + last.ms : null;
};
const failure = (r) => (ok(r.commit) ? r.land : r.commit);

/** The stop rules a window of arrival records trips; `server_limits` are limit kills only
 * Cloudflare's analytics show. */
export function verdict(records, target_ms, server_limits = 0) {
  const abandoned = records.filter((r) => r.abandoned);
  const failed = records.filter((r) => !r.abandoned && !ok(r.land)).map(failure);
  return stopReasons({
    total: records.length,
    errors: failed.filter((f) => !expectedConflict(f)).length + abandoned.length,
    p95_ms: percentiles(records.filter((r) => ok(r.land)).map((r) => finished(r) - r.scheduled_at)).p95_ms,
    target_ms,
    limits: limitErrors([...failed, ...abandoned]).length + server_limits,
  });
}

/** One step's figures from its arrival records (bench client clock). */
export function summarizeStep(records, { rate, duration_ms, warmup_ms, window_start, target_ms = TARGETS.sustained_ms }) {
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
  const missed = [achieved < MISS.achieved * offered && 'achieved', ...verdict(records, target_ms)].filter(Boolean);
  return {
    rate,
    arrivals: records.length,
    offered_per_second: Number(offered.toFixed(1)),
    achieved_per_second: Number(achieved.toFixed(1)),
    landed: landed.length,
    refused: refused.length,
    refusal_rate: Number(refusalRate.toFixed(4)),
    refusals: byCode,
    conflicts: refused.map(failure).filter(expectedConflict).length,
    d1_errors: d1Errors(refused.map(failure)).length,
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

/** One step on every repository; `watch` judges a finished segment, and once it trips no later
 * segment starts (those in flight finish). `rate` is per repository. */
async function step(session, repos, tokenFor, o, index, watch) {
  const shards = Math.ceil(o.rate / o.per_shard);
  const segments = Math.ceil(o.step_s / o.segment_s);
  const segmentMs = (o.step_s * 1000) / segments;
  const lead = o.lead_ms ?? LEAD_MS;
  const start = Date.now() + lead;
  const counts = Array.from({ length: segments }, () => ({ left: shards * repos.length, records: [] }));
  let stopped = null;
  const judge = (segment, reasons) => {
    if (reasons.length && !stopped) stopped = { segment, reasons };
  };
  const calls = [];
  for (let j = 0; j < segments; j++)
    for (const [r, repo] of repos.entries())
      for (let s = 0; s < shards; s++) {
        const open = {
          rate: o.rate / shards,
          duration_ms: segmentMs,
          start_at: start + j * segmentMs,
          arrivals: o.arrivals,
          seed: (index + 1) * 1_000_000 + j * 1000 + s + r * 100_000_000,
          prefix: pathPrefix({ layout: o.layout, dirs: o.dirs, run: o.run, rate: o.rate, shard: s, segment: j }),
          token: tokenFor(r, s),
          mode: o.mode,
          timeout_ms: TIMEOUT_MS,
          drain_ms: DRAIN_MS,
        };
        calls.push(
          (async () => {
            await new Promise((done) => setTimeout(done, Math.max(0, open.start_at - lead - Date.now())));
            if (stopped) return null;
            const reply = await session.invoke({ repo, open });
            // An invocation that failed outright loses its whole schedule: abandoned arrivals.
            const out = reply.failed
              ? { segment: j, repo: r, began_at: open.start_at, capped: false, max_waiting: 0, results: schedule(open).map((t) => ({ scheduled_at: open.start_at + t, abandoned: true, client_error: reply.failed })) }
              : { segment: j, repo: r, ...reply };
            const count = counts[j];
            count.records.push(...out.results);
            // A limit error stops at once; the rates are judged over a whole segment.
            judge(j, --count.left === 0 ? watch(count.records) : watch(out.results).filter((reason) => reason === 'limit'));
            return out;
          })(),
        );
      }
  const replies = (await Promise.all(calls)).filter(Boolean);
  const records = replies.flatMap((r) => r.results);
  const windowStart = Math.min(...replies.filter((r) => r.segment === 0).map((r) => r.began_at));
  const ranSegments = Math.max(...replies.map((r) => r.segment)) + 1;
  const perRepo = repos.map((_, r) => percentiles(replies.filter((x) => x.repo === r).flatMap((x) => x.results).filter((x) => ok(x.land)).map((x) => finished(x) - x.scheduled_at)).p95_ms);
  return {
    shards,
    segments,
    ran_segments: ranSegments,
    stopped,
    capped_invocations: replies.filter((r) => r.capped).length,
    failed_invocations: replies.filter((r) => r.results.some((x) => x.client_error)).length,
    max_client_waiting: Math.max(...replies.map((r) => r.max_waiting)),
    per_repo_p95: percentiles(perRepo.filter((v) => v !== null)),
    ...summarizeStep(records, { rate: o.rate * repos.length, duration_ms: ranSegments * segmentMs, warmup_ms: o.warmup_s * 1000, window_start: windowStart, target_ms: o.target_ms }),
  };
}

async function sweep(session, repos, tokenFor, o, sampler) {
  const steps = [];
  let knee = null;
  const watch = (records) => verdict(records, o.target_ms, sampler?.limits() ?? 0);
  for (const [index, rate] of o.rates.entries()) {
    const result = await step(session, repos, tokenFor, { ...o, rate }, index, watch);
    steps.push(result);
    console.error(`step ${rate}/s x ${repos.length}: achieved ${result.achieved_per_second}/s, p95 ${result.latency.p95_ms} ms, refused ${result.refused}${result.missed.length ? `, missed: ${result.missed.join(', ')}` : ''}${result.stopped ? `, stopped in segment ${result.stopped.segment}` : ''}${result.client.limited ? ' (bench client limited)' : ''}`);
    if (result.missed.length || result.stopped) {
      knee = rate;
      break;
    }
  }
  return { steps, knee };
}

/** What the results table reads from a run. */
export function sustainedSummary(steps, o, repoCount, server, clients) {
  const last = steps.at(-1);
  const count = (pick) => steps.reduce((n, s) => n + pick(s), 0);
  const broke = [...new Set(steps.flatMap((s) => [...s.missed, ...(s.stopped?.reasons ?? [])]))];
  const errors_ = count((s) => s.refused - s.conflicts + s.client.abandoned);
  return {
    stage: o.stage ?? null,
    size: `${repoCount} × ${last.rate / repoCount}/s, ${o.step_s} s`,
    arm: `${o.principals} ${o.layout}`,
    clients,
    rate_per_s: last.achieved_per_second,
    land_p95_ms: last.latency.p95_ms,
    arrivals: count((s) => s.arrivals),
    errors: errors_,
    d1_errors: count((s) => s.d1_errors),
    bytes_per_version: server?.summary.repos[0]?.growth?.bytes_per_version ?? null,
    compaction_kept_up: server?.summary.repos[0]?.compaction?.kept_up ?? null,
    what_broke: broke.length ? `${broke.join(', ')}${last.errors[0] ? `: ${last.errors[0][0]}` : ''}` : null,
  };
}

/** `o.repos`: saved repositories to reuse; without them one is created and later deleted. */
export async function sustained(session, options) {
  const o = { principals: 'tokens', layout: 'spread', target_ms: TARGETS.sustained_ms, run: runId(), ...options };
  const repos = o.repos ?? [await session.createRepo('sustained', [{ path: 'README.md', content_b64: Buffer.from('sustained landing rate\n').toString('base64') }])];
  const slots = estimate({ ...o, repo_count: repos.length }).max_shards;
  const credentials = await writerCredentials(session, repos, { principals: o.principals, slots, run: o.run, pats: o.pats });
  try {
    const { value, server } = await sampled(session, repos, o, (sampler) => sweep(session, repos, credentials.tokenFor, o, sampler));
    const sustainedRates = value.steps.filter((s) => !s.missed.length).map((s) => s.rate / repos.length);
    return {
      repos,
      run: o.run,
      rates: o.rates,
      step_s: o.step_s,
      per_shard: o.per_shard,
      arrivals: o.arrivals,
      mode: o.mode ?? 'default',
      principals: o.principals,
      layout: o.layout,
      clients: session.clients,
      target_p95_ms: o.target_ms,
      miss_rule: MISS,
      knee: value.knee,
      last_sustained: sustainedRates.at(-1) ?? null,
      steps: value.steps,
      server,
      summary: sustainedSummary(value.steps, o, repos.length, server, session.clients),
    };
  } finally {
    const left = await credentials.revoke();
    if (left) console.error(`${left} credentials of run ${o.run} could not be revoked`);
  }
}
