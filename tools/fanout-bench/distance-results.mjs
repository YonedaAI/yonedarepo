// Stage 6's tables, from its evidence files: median of the run medians (min–max of them), never
// from memory. Delay is client time less the server's own total, per request.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENTS } from './regions.mjs';
import { limitHeld, LIMITS } from './distance-plan.mjs';

const DOC = fileURLToPath(new URL('../../docs/load-testing.md', import.meta.url));
const START = '<!-- distance-results:start (tools/platform-distance-bench.mjs --results) -->';
const END = '<!-- distance-results:end -->';

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];
/** `12 (10–15)` of finite values, or a dash. */
export function spread(values) {
  const seen = values.filter(Number.isFinite).map(Math.round);
  return seen.length ? `${median(seen)} (${Math.min(...seen)}–${Math.max(...seen)})` : '–';
}

export async function readDistance(dir) {
  const names = (await readdir(dir).catch(() => [])).filter((f) => /^(burst|limits)-.*\.json$/.test(f)).sort();
  return Promise.all(names.map(async (f) => JSON.parse(await readFile(resolve(dir, f), 'utf8')).result));
}

const OPS = [
  ['Commit', (r) => r.commit, 'commit'],
  ['Land', (r) => r.land, 'land'],
  ['Read', (r) => r.read, 'read'],
];

export function burstTable(results) {
  const bursts = results.filter((r) => r.kind === 'burst');
  const lines = ['| Client | Writers | Runs | Operation | Client p50 | Client p95 | Server p50 | Delay p50 | Delay p95 |', '|---|---:|---:|---|---:|---:|---:|---:|---:|'];
  const sizes = [...new Set(bursts.map((r) => r.writers))].sort((a, b) => a - b);
  for (const writers of sizes)
    for (const client of Object.keys(CLIENTS)) {
      const runs = bursts.filter((r) => r.client === client && r.writers === writers);
      if (!runs.length) continue;
      for (const [label, op, key] of OPS) {
        const of = (pick) => spread(runs.map(pick));
        lines.push(`| ${CLIENTS[client].label} | ${writers} | ${runs.length} | ${label} | ${of((r) => op(r).client?.p50_ms)} | ${of((r) => op(r).client?.p95_ms)} | ${of((r) => op(r).server?.p50_ms)} | ${of((r) => r.delay?.[key]?.p50_ms)} | ${of((r) => r.delay?.[key]?.p95_ms)} |`);
      }
    }
  return lines.join('\n');
}

/** Every client colo seen, with its share of that client's requests. */
export function edgeTable(results) {
  const lines = ['| Client | Placed near | Requests entered at |', '|---|---|---|'];
  for (const [name, { label, placed }] of Object.entries(CLIENTS)) {
    const counts = {};
    for (const r of results.filter((x) => x.kind === 'burst' && x.client === name)) for (const [edge, n] of Object.entries(r.edges ?? {})) counts[edge] = (counts[edge] ?? 0) + n;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total) lines.push(`| ${label} | ${placed} | ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([edge, n]) => `${edge} ${((100 * n) / total).toFixed(1)}%`).join(', ')} |`);
  }
  return lines.join('\n');
}

export function limitTable(results) {
  const lines = ['| Client | Limiter | Limit | Rounds | Passed | Refused | Held every round |', '|---|---|---:|---:|---:|---:|---|'];
  for (const [name, { label }] of Object.entries(CLIENTS)) {
    const rounds = results.filter((r) => r.kind === 'limits' && r.client === name);
    if (!rounds.length) continue;
    for (const key of ['public', 'auth']) {
      const held = rounds.every((r) => limitHeld(r[key], LIMITS[key]));
      lines.push(`| ${label} | ${key} | ${LIMITS[key]} | ${rounds.length} | ${spread(rounds.map((r) => r[key].allowed))} | ${spread(rounds.map((r) => r[key].refused))} | ${held ? 'yes' : '**no**'} |`);
    }
  }
  const both = results.filter((r) => r.kind === 'limits-both');
  if (both.length) lines.push(`| Europe and Asia at once | public | ${LIMITS.public} | ${both.length} | ${spread(both.map((r) => r.both.allowed))} | ${spread(both.map((r) => r.both.refused))} | ${both.every((r) => limitHeld(r.both, LIMITS.public)) ? 'yes: one counter' : '**no: a counter per location**'} |`);
  const fleet = results.filter((r) => r.kind === 'burst');
  if (fleet.length) lines.push(`\nA fleet behind one address: ${fleet.reduce((n, r) => n + (r.rate_limited ?? 0), 0)} of ${fleet.reduce((n, r) => n + r.writers * 3, 0)} token requests refused as rate limited.`);
  return lines.join('\n');
}

export function renderDistance(results, revisions = []) {
  if (!results.length) return 'None yet.';
  const stopped = results.filter((r) => r.stops?.length).map((r) => `${r.client} at ${r.writers} writers, run ${r.run}: ${r.stops.join(', ')}`);
  return [
    `${results.length} evidence files${revisions.length ? `, last at \`${revisions.at(-1).slice(0, 8)}\`` : ''}. Cells: median of run values in ms (min–max of them).`,
    `**Bursts, today's path**\n\n${burstTable(results)}`,
    `**Where the clients really ran**\n\n${edgeTable(results)}`,
    `**Limiters**\n\n${limitTable(results)}`,
    stopped.length ? `**Stopped:** ${stopped.join('; ')}` : '**Stopped:** none.',
  ].join('\n\n');
}

export function replaceDistance(doc, body) {
  const [from, to] = [doc.indexOf(START), doc.indexOf(END)];
  if (from < 0 || to < from) throw new Error('docs/load-testing.md has lost its distance results markers');
  return `${doc.slice(0, from + START.length)}\n${body}\n${doc.slice(to)}`;
}

export async function updateDistance(dir, doc = DOC) {
  const results = await readDistance(dir);
  await writeFile(doc, replaceDistance(await readFile(doc, 'utf8'), renderDistance(results)));
  return results.length;
}
