// Pure parts of the size ladder (size-ladder.mjs): parsing what the platform reports
// (Server-Timing, the `yoneda-timing` line a fetch ends with, Git's curl trace), planning an
// import as pushes within the receive limits, and aggregating runs into min/median/max.
// No I/O here, so tests/runtime/size-ladder.test.mjs covers it without a platform.

/** Receive-pack limits per push (platform_git_receive.rs): 64 MiB of pack held (files
 * over 8 MiB stream and are not held), 40,000 objects, 100 MiB per file. An import plans
 * below them: on-disk sizes are a pack's estimate. */
export const PUSH_LIMITS = { objects: 30_000, bytes: 40 * 1024 * 1024, objectBytes: 100 * 1024 * 1024 };

/** `name;dur=12.3;desc="4", ...` → `{ name: { ms, n } }` (n: items the phase counted). */
export function parseServerTiming(header) {
  const phases = {};
  for (const part of String(header ?? '').split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const value = { ms: 0, n: 1 };
    for (const param of params) {
      const [key, raw = ''] = param.trim().split('=');
      const text = raw.replace(/^"|"$/g, '');
      if (key === 'dur') value.ms = Number(text);
      if (key === 'desc' && text !== '' && Number.isFinite(Number(text))) value.n = Number(text);
    }
    const seen = phases[name];
    phases[name] = seen ? { ms: seen.ms + value.ms, n: seen.n + value.n } : value;
  }
  return phases;
}

/** `yoneda-timing walk=262ms entries=7270 read=168.2MiB cache=hit ...` → numbers in ms and
 * MiB (unit dropped, keys keep their names), anything else as text. */
export function parseTimingLine(line) {
  const fields = {};
  const body = String(line ?? '').replace(/^.*?yoneda-timing\s*/, '');
  for (const pair of body.trim().split(/\s+/)) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const key = pair.slice(0, at);
    const raw = pair.slice(at + 1);
    const number = /^(-?\d+(?:\.\d+)?)(ms|MiB)?$/.exec(raw);
    fields[key] = number ? Number(number[1]) : raw;
  }
  return fields;
}

/** Requests in a `GIT_TRACE_CURL` file (with `GIT_TRACE_CURL_NO_DATA`): each sent request
 * and the Server-Timing its answer carried. */
export function parseCurlTrace(text) {
  const requests = [];
  for (const line of String(text ?? '').split('\n')) {
    const sent = /=> Send header: (GET|POST) (\S+)/.exec(line);
    if (sent) requests.push({ request: `${sent[1]} ${sent[2].replace(/\?.*/, '')}`, timing: '' });
    const timing = /<= Recv header: server-timing: (.*)/i.exec(line);
    if (timing && requests.length) requests.at(-1).timing = timing[1].trim();
  }
  return requests;
}

/** Calls the timed phases name, summed over requests: authority/shard round trips and R2
 * reads. Only phases the platform times are seen, so these are lower bounds. */
export function requestCounts(phases) {
  const sum = (test) =>
    Object.entries(phases).reduce((n, [name, p]) => (test(name) ? n + p.n : n), 0);
  return {
    do_calls: sum((n) => n.startsWith('do.') || n.startsWith('shard.record') || n === 'head.fetch'),
    r2_reads: sum((n) =>
      ['bundle.read', 'read.r2', 'read.edge', 'git.pack_cached', 'search.segment', 'view.facts'].includes(n),
    ),
  };
}

/** Merges several requests' phases (a clone makes a few). */
export function mergePhases(list) {
  const out = {};
  for (const phases of list)
    for (const [name, p] of Object.entries(phases))
      out[name] = out[name] ? { ms: out[name].ms + p.ms, n: out[name].n + p.n } : { ...p };
  return out;
}

/** `{ n, min, median, max }` of the finite numbers in `values` (median: the middle one, or
 * the mean of the two middle ones); nulls when there are none. */
export function stats(values) {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0, min: null, median: null, max: null };
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n: sorted.length, min: sorted[0], median, max: sorted.at(-1) };
}

/**
 * Results (`{ rung, op, run, ok, wall_ms, error?, metrics }`) by rung and op: how many ran
 * and passed, wall time and every numeric metric as min/median/max over the passing runs,
 * and the distinct errors of the failing ones.
 */
export function aggregate(results) {
  const groups = new Map();
  for (const r of results) {
    const key = `${r.rung}\u0000${r.op}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const list of groups.values()) {
    const passed = list.filter((r) => r.ok);
    const metrics = {};
    const names = new Set(passed.flatMap((r) => Object.keys(r.metrics ?? {})));
    for (const name of [...names].sort()) {
      const s = stats(passed.map((r) => r.metrics?.[name]));
      if (s.n > 0) metrics[name] = s;
    }
    out.push({
      rung: list[0].rung,
      op: list[0].op,
      runs: list.length,
      ok: passed.length,
      wall_ms: stats(passed.map((r) => r.wall_ms)),
      metrics,
      errors: [...new Set(list.filter((r) => !r.ok).map((r) => String(r.error ?? 'failed')))],
    });
  }
  return out;
}

const cell = (s, digits = 0) =>
  s && s.n ? [s.min, s.median, s.max].map((v) => v.toFixed(digits)).join(' / ') : '–';

/** The aggregate as a markdown table, rungs in ladder order, each with what was expected. */
export function markdownTable(rows, ladder) {
  const order = new Map(ladder.rungs.map((r, i) => [r.name, i]));
  const sorted = [...rows].sort(
    (a, b) => (order.get(a.rung) ?? 99) - (order.get(b.rung) ?? 99) || a.op.localeCompare(b.op),
  );
  const lines = [
    '| Rung | Op | OK | Wall ms (min / median / max) | Sent MiB | Read MiB | read_wait ms | DO calls | R2 reads | Errors |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of sorted) {
    const m = r.metrics;
    lines.push(
      `| ${r.rung} | ${r.op} | ${r.ok}/${r.runs} | ${cell(r.wall_ms)} | ${cell(m.sent, 1)} | ${cell(m.read, 1)} | ${cell(m.read_wait)} | ${cell(m.do_calls)} | ${cell(m.r2_reads)} | ${r.errors.join('; ').replace(/\|/g, '\\|').slice(0, 200)} |`,
    );
  }
  lines.push('', '| Rung | Source | Expected |', '|---|---|---|');
  for (const rung of ladder.rungs)
    lines.push(`| ${rung.name} | ${rung.source} @ ${rung.commit.slice(0, 12)} | ${rung.expect.join(' ')} |`);
  return `${lines.join('\n')}\n`;
}

/**
 * Pushes that import a first-parent history of `count` commits (index 0 oldest) within
 * `limits`: each push moves main to a later first-parent commit, the furthest whose new
 * objects (`cost(from, to)`: what commit `to` adds over commit `from`, `from` -1 for none)
 * stay within the limits. A single step over them is still one push (it will be refused,
 * which the ladder reports). Probes gallop forward (1, 2, 4, ... commits) and then bisect,
 * so each spans about one push's worth of history, never the whole remainder.
 */
export async function planCheckpoints(count, cost, limits = PUSH_LIMITS) {
  const fits = (c) => c.objects <= limits.objects && c.bytes <= limits.bytes;
  const checkpoints = [];
  let from = -1;
  while (from < count - 1) {
    // `low` fits (or is the single next step), `high` does not (or is past the end).
    let low = from + 1;
    let high = count;
    if (fits(await cost(from, low)))
      for (let step = 1; ; step *= 2) {
        const next = Math.min(from + 1 + step, count - 1);
        if (next === low) break;
        if (!fits(await cost(from, next))) {
          high = next;
          break;
        }
        low = next;
        if (next === count - 1) break;
      }
    else high = low;
    while (high - low > 1 && high < count) {
      const mid = (low + high) >> 1;
      if (fits(await cost(from, mid))) low = mid;
      else high = mid;
    }
    checkpoints.push(low);
    from = low;
  }
  return checkpoints;
}

/** Whether `state` already holds a finished result for `rung`/`op`/`run` (failed ones are
 * retried unless `keepFailed`). */
export function done(state, rung, op, run, keepFailed = false) {
  const found = state.results.find((r) => r.rung === rung && r.op === op && r.run === run);
  return Boolean(found && (found.ok || keepFailed));
}

/** `state` with `result` recorded in place of any earlier one for the same rung/op/run. */
export function record(state, result) {
  state.results = state.results.filter(
    (r) => !(r.rung === result.rung && r.op === result.op && r.run === result.run),
  );
  state.results.push(result);
  return state;
}

/** Git's progress lines (local or `remote: `), which a failure's stderr is mostly made of. */
const PROGRESS =
  /^(remote: )?(Cloning into|Enumerating|Counting|Compressing|Receiving|Resolving|Writing|Total|Updating files|Checking out|Filtering content)\b/;

/** What a failed Git command said: its last five lines that are not progress (`\r` ends
 * progress updates as `\n` ends lines), joined by ` | `: a clone cut off says why in
 * about five (curl's error, the bytes missing, then fetch-pack and index-pack). */
export function gitError(stderr) {
  return String(stderr)
    .split(/[\r\n]/)
    .filter((line) => line.trim() && !PROGRESS.test(line))
    .slice(-5)
    .join(' | ');
}

/** The file blame and history read: `configured` when the imported tip holds it (`tip`, its
 * files), else the one its history changed most (`changed`, a path per change) that the tip
 * holds, of `configured`'s extension when any is (source, not a manifest), else the tip's
 * first file; null when it has none. An import that stopped early may predate `configured`. */
export function readPath(configured, tip, changed) {
  const held = new Set(tip);
  if (held.has(configured)) return configured;
  const counts = new Map();
  for (const path of changed) if (held.has(path)) counts.set(path, (counts.get(path) ?? 0) + 1);
  const extension = /\.[^./]+$/.exec(configured)?.[0];
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([p]) => p);
  return ranked.find((p) => extension && p.endsWith(extension)) ?? ranked[0] ?? tip[0] ?? null;
}
