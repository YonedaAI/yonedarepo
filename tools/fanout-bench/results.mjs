// The results table of docs/load-testing.md, rebuilt from the evidence files (never typed): one
// row per stage, size, arm and client count, with min, median and max over its runs. Repository
// ids stay in the evidence; only figures reach the doc.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { EVIDENCE_DIR } from './driver.mjs';
import { isDevUrl } from './guard.mjs';

const START = '<!-- results:start (tools/platform-load-stages.mjs --results) -->';
const END = '<!-- results:end -->';
const DOC = fileURLToPath(new URL('../../docs/load-testing.md', import.meta.url));

/** Min, median and max of the numbers among `values`. */
export function spread(values) {
  const seen = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!seen.length) return null;
  return { min: seen[0], median: seen[Math.floor((seen.length - 1) / 2)], max: seen.at(-1) };
}

const triple = (s) => (s ? `${s.min} / ${s.median} / ${s.max}` : '–');
const yesNo = (values) => {
  const seen = values.filter((v) => v === true || v === false);
  return seen.length ? `${seen.filter(Boolean).length} of ${seen.length}` : '–';
};

/** One row per stage, size, arm and client count, from recorded runs of dev. */
export function resultRows(records) {
  const groups = new Map();
  for (const record of records) {
    const s = record.result?.summary;
    if (record.schema !== 2 || !s?.stage || !isDevUrl(record.target)) continue;
    const key = [s.stage, s.size, s.arm, s.clients].join('|');
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()]
    .map((runs) => {
      const ordered = [...runs].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
      const last = ordered.at(-1);
      const summaries = ordered.map((r) => r.result.summary);
      return {
        date: last.recorded_at.slice(0, 10),
        commit: last.revision.slice(0, 8),
        stage: last.result.summary.stage,
        size: last.result.summary.size,
        arm: last.result.summary.arm,
        clients: last.result.summary.clients,
        runs: ordered.length,
        rate: spread(summaries.map((s) => s.rate_per_s)),
        p95: spread(summaries.map((s) => s.land_p95_ms)),
        errors: summaries.reduce((n, s) => n + (s.errors ?? 0), 0),
        arrivals: summaries.reduce((n, s) => n + (s.arrivals ?? 0), 0),
        bytes: spread(summaries.map((s) => s.bytes_per_version)),
        kept_up: yesNo(summaries.map((s) => s.compaction_kept_up)),
        broke: [...new Set(summaries.map((s) => s.what_broke).filter(Boolean))].join('; ').replaceAll('|', '/') || '–',
      };
    })
    .sort((a, b) => a.stage.localeCompare(b.stage) || a.size.localeCompare(b.size, 'en', { numeric: true }) || a.arm.localeCompare(b.arm) || a.clients - b.clients);
}

/** The table's Markdown; a line saying so when nothing has run. */
export function renderResults(rows) {
  if (!rows.length) return 'None yet.';
  const head = '| Date | Commit | Stage | Size | Arm | Clients | Runs | Landings/s (min / median / max) | Land p95 ms (min / median / max) | Errors | Bytes per version | Compaction kept up | What broke |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const lines = rows.map((r) => `| ${r.date} | \`${r.commit}\` | ${r.stage} | ${r.size} | ${r.arm} | ${r.clients} | ${r.runs} | ${triple(r.rate)} | ${triple(r.p95)} | ${r.errors} of ${r.arrivals} | ${triple(r.bytes)} | ${r.kept_up} | ${r.broke} |`);
  return [head, ...lines].join('\n');
}

/** `doc` with the text between the results markers replaced. */
export function replaceResults(doc, table) {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < start) throw new Error('The results markers are missing from docs/load-testing.md');
  return `${doc.slice(0, start + START.length)}\n${table}\n${doc.slice(end)}`;
}

/** Rebuilds the doc's table from every evidence file; answers how many rows it now has. */
export async function updateResults(dir = EVIDENCE_DIR, doc = DOC) {
  const names = await readdir(resolve(dir)).catch(() => []);
  const records = [];
  for (const name of names.filter((n) => n.endsWith('.json') && !n.startsWith('pool-'))) {
    const parsed = JSON.parse(await readFile(resolve(dir, name), 'utf8').catch(() => 'null'));
    if (parsed) records.push(parsed);
  }
  const rows = resultRows(records);
  await writeFile(doc, replaceResults(await readFile(doc, 'utf8'), renderResults(rows)));
  return rows.length;
}
