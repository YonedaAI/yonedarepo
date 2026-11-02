// What a run adds up to: per region and step, and per simulated hour so the day's rhythm shows.
// Client time is what the region saw; server time is `Server-Timing` total, where one came back.
import { hopsOf } from '../fanout-bench/region-results.mjs';
import { failed, refused } from './run.mjs';
import { classOf } from './sessions.mjs';

function figures(rows) {
  const answered = rows.filter((r) => r.ok);
  const ms = answered.map((r) => r.ms).sort((a, b) => a - b);
  const server = answered.map((r) => r.server).filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  const at = (list, q) => (list.length ? list[Math.ceil(list.length * q) - 1] : null);
  return {
    requests: rows.length,
    failed: rows.filter(failed).length,
    conflicts: rows.filter(refused).length,
    client: { min: ms[0] ?? null, median: at(ms, 0.5), p95: at(ms, 0.95), max: ms.at(-1) ?? null },
    server: { min: server[0] ?? null, median: at(server, 0.5), p95: at(server, 0.95), max: server.at(-1) ?? null },
  };
}

const grouped = (rows, keyOf) => {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([key, own]) => [key, figures(own)]));
};

/** Failed rows counted by status, code and message. */
function failures(rows) {
  const counts = {};
  for (const r of rows.filter(failed)) {
    const key = `${r.label} ${r.status} ${r.error}: ${r.message ?? ''}`.slice(0, 200);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 30);
}

export function summarize({ rows, counts, ms, stopped, settled }, { plan, placed, sampler }) {
  const began = Math.min(...rows.map((r) => r.started_at ?? Infinity));
  const minuteOf = (r) => Math.floor(((r.started_at ?? began) - began) / 60_000);
  return {
    stopped,
    settled,
    ran_ms: ms,
    plan: { arm: plan.arm, minutes: plan.minutes, peak_sessions: plan.peakSessions, peak_per_minute: Number(plan.peakPerMinute.toFixed(1)), accounts: plan.accounts, repositories: plan.accounts * plan.reposPerAccount, seed: plan.seed },
    clients: placed,
    sessions: counts,
    all: figures(rows),
    by_region_class: grouped(rows, (r) => `${r.region} ${classOf(r.label)}`),
    by_region_label: grouped(rows, (r) => `${r.region} ${r.label}`),
    by_minute: grouped(rows, (r) => String(minuteOf(r))),
    // What each region's requests still reached (`hop.*`, on the region arm only).
    hops: Object.fromEntries([...new Set(rows.map((r) => r.region))].sort().map((region) => [region, hopsOf(rows.filter((r) => r.region === region))])),
    failures: failures(rows),
    server: sampler,
  };
}

const cell = (s) => (s.median === null ? '–' : `${s.median} / ${s.p95} / ${s.max}`);

/** The tables for the doc: one row per region and class. */
export function renderSummary(s) {
  const head = '| Region, class | Requests | Failed | Conflicts | Client ms (median / p95 / max) | Server ms (median / p95 / max) |\n|---|---|---|---|---|---|';
  const rows = Object.entries(s.by_region_class).map(([key, f]) => `| ${key} | ${f.requests} | ${f.failed} | ${f.conflicts} | ${cell(f.client)} | ${cell(f.server)} |`);
  return [head, ...rows].join('\n');
}
