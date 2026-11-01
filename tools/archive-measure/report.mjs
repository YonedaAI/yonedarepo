// Archive stage A's tables, from its evidence files alone. Bytes come from what the database
// reports, per item of work; a check run's evidence is too small for that, so it is the exact
// length the API returns. An arm with fewer runs than the other is printed as it is.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOC = fileURLToPath(new URL('../../docs/load-testing.md', import.meta.url));
const START = '<!-- archive-results:start (tools/platform-archive-measure.mjs --results) -->';
const END = '<!-- archive-results:end -->';

const sorted = (values) => [...values].filter(Number.isFinite).sort((a, b) => a - b);
/** `{min, median, max}` of a metric over an arm's runs, or null with nothing measured. */
export function span(values) {
  const seen = sorted(values);
  return seen.length ? { min: seen[0], median: seen[Math.floor((seen.length - 1) / 2)], max: seen.at(-1) } : null;
}
const round = (n) => (Math.abs(n) >= 100 ? Math.round(n) : Number(n.toFixed(1)));
const show = (s) => (s ? `${round(s.median)} (${round(s.min)}–${round(s.max)})` : '–');
const perItem = (step, key) => (step.bytes[key] === undefined ? null : step.bytes[key] / step.count);
const sum = (values) => values.reduce((a, b) => a + b, 0);

/** What each table reads off one run. */
export const METRICS = [
  ['Bytes per new branch, authority', (r) => perItem(r.steps.branches, 'authority')],
  ['Bytes per landing, authority', (r) => perItem(r.steps.landings, 'authority')],
  ['Bytes per landing left in shards', (r) => perItem(r.steps.landings, 'shards')],
  ['Evidence bytes per check run', (r) => sum(r.steps.checks.evidence_bytes) / (r.steps.checks.evidence_bytes.length || NaN)],
];
export const COSTS = [
  ['New branch, server p50', (r) => r.steps.branches.move.server?.p50_ms],
  ['New branch, server p95', (r) => r.steps.branches.move.server?.p95_ms],
  ['Commit on a branch, server p50', (r) => r.steps.branches.commit.server?.p50_ms],
  ['Commit, server p50', (r) => r.steps.landings.commit.server?.p50_ms],
  ['Land, server p50', (r) => r.steps.landings.land.server?.p50_ms],
  ['Land, server p95', (r) => r.steps.landings.land.server?.p95_ms],
];

const change = (off, on) => (off?.median ? `${round((100 * (on.median - off.median)) / off.median)}%` : '–');

export function table(heading, metrics, off, on) {
  const lines = [`| ${heading} | Off | On | Change |`, '|---|---:|---:|---:|'];
  for (const [label, read] of metrics) {
    const [a, b] = [span(off.map(read)), span(on.map(read))];
    lines.push(`| ${label} | ${show(a)} | ${show(b)} | ${a && b ? change(a, b) : '–'} |`);
  }
  return lines.join('\n');
}

/** A real agent's work on a branch, off against on, from the table's own medians. `landings`
 * says how many landings one branch carries; it is an assumption, shown beside the answer. */
export function perBranch(off, on, landings = 10) {
  const cost = (runs) => {
    const [branch, landing, shards] = METRICS.slice(0, 3).map(([, read]) => span(runs.map(read))?.median);
    return branch + landings * (landing + shards);
  };
  const [a, b] = [cost(off), cost(on)];
  return Number.isFinite(a) && Number.isFinite(b) && b > 0 ? { landings, off_bytes: Math.round(a), on_bytes: Math.round(b), life_multiple: Number((a / b).toFixed(2)) } : null;
}

export function checksHeld(runs) {
  const checks = runs.map((r) => r.steps.checks);
  return { asked: sum(checks.map((c) => c.asked)), passed: sum(checks.map((c) => c.passed)), logs_readable: sum(checks.map((c) => c.logs_readable)) };
}

const baselineTable = (rows) =>
  ['| Repository | Head | Tail rows | Authority MB | Shards MB | Segments a sweep would move |', '|---|---:|---:|---:|---:|---:|', ...rows.map((r) => (r.unreadable ? `| ${r.name} | unreadable (${r.unreadable}) | | | | |` : `| ${r.name} | ${r.head} | ${r.tail_rows} | ${(r.authority / 1e6).toFixed(1)} | ${(r.shards / 1e6).toFixed(1)} | ${r.sweep_would_move ?? '–'} |`))].join('\n');

export function renderArchive({ off = [], on = [], baseline = null }) {
  if (!off.length && !on.length && !baseline) return 'None yet.';
  const parts = [];
  if (off.length || on.length) {
    parts.push(`${off.length} runs with the switches off, ${on.length} on. Cells: median over runs (min–max).`);
    parts.push(table('What it saves', METRICS, off, on));
    parts.push(table('What it costs, ms', COSTS, off, on));
    const whole = perBranch(off, on);
    if (whole) parts.push(`Derived: a branch of ${whole.landings} landings (an assumption) costs ${whole.off_bytes} bytes off and ${whole.on_bytes} on, so a repository lasts ${whole.life_multiple}× as long at that shape.`);
    const held = checksHeld([...off, ...on]);
    parts.push(`Check runs: ${held.passed} of ${held.asked} passed, ${held.logs_readable} logs read back.`);
    const unsettled = [...off, ...on].filter((r) => !r.after.settled).length;
    if (unsettled) parts.push(`**${unsettled} runs never settled:** their sizes may still have been moving.`);
  }
  if (baseline) parts.push(`**The owner's repositories, read only.** The switches change new writes only, so these don't shrink.\n\n${baselineTable(baseline.repositories)}`);
  return parts.join('\n\n');
}

export function replaceArchive(doc, body) {
  const [from, to] = [doc.indexOf(START), doc.indexOf(END)];
  if (from < 0 || to < from) throw new Error('docs/load-testing.md has lost its archive results markers');
  return `${doc.slice(0, from + START.length)}\n${body}\n${doc.slice(to)}`;
}

export async function readArchive(dir) {
  const names = (await readdir(dir).catch(() => [])).filter((f) => f.startsWith('archive-')).sort();
  const records = await Promise.all(names.map(async (f) => [f, JSON.parse(await readFile(resolve(dir, f), 'utf8')).result]));
  const of = (arm) => records.filter(([f]) => f.startsWith(`archive-${arm}-`)).map(([, result]) => result);
  return { off: of('off'), on: of('on'), baseline: of('baseline').at(-1) ?? null };
}

export async function updateArchive(dir, doc = DOC) {
  const found = await readArchive(dir);
  await writeFile(doc, replaceArchive(await readFile(doc, 'utf8'), renderArchive(found)));
  return found.off.length + found.on.length;
}
