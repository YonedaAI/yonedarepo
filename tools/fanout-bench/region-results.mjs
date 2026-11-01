// The results tables of docs/global-scale-plan.md, rebuilt from the evidence files, never typed:
// for each pair of client and data region, each operation's median in each run, then the min,
// median and max of those medians. A sample that failed is counted, and never averaged in.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_DIR } from './driver.mjs';
import { CLIENTS, DATA_REGIONS } from './regions.mjs';
import { spread } from './results.mjs';

const START = '<!-- region-results:start (tools/platform-region-matrix.mjs --results) -->';
const END = '<!-- region-results:end -->';
const DOC = fileURLToPath(new URL('../../docs/global-scale-plan.md', import.meta.url));
export const OPS = ['read_token', 'read_pat', 'list', 'clone', 'commit', 'land', 'push', 'create'];
const OP_NAMES = { read_token: 'Read, repo token', read_pat: 'Read, personal token', list: 'List', clone: 'Clone', commit: 'Commit', land: 'Land', push: 'Push', create: 'Create' };

const median = (values) => spread(values)?.median ?? null;
const cell = (s) => (s ? `${Math.round(s.median)} (${Math.round(s.min)}–${Math.round(s.max)})` : 'not measured');
const pairsOf = (records) => records.flatMap((r) => r.result?.pairs ?? []);

/** A pair's figures for one op: the spread of each run's median, and how many samples failed.
 * The first read of a run is its cold one, kept apart. */
function opFigures(pairs, op, key) {
  const runs = pairs.map((p) => (p.ops?.[op] ?? []).filter((r, i) => r.ok && r[key] !== null && r[key] !== undefined && (!op.startsWith('read') || i > 0)).map((r) => r[key]));
  return { spread: spread(runs.map(median)), runs: runs.filter((r) => r.length).length, failed: pairs.flatMap((p) => p.ops?.[op] ?? []).filter((r) => !r.ok).length };
}

const pairRows = (records, key) => {
  const pairs = pairsOf(records);
  return Object.keys(CLIENTS).flatMap((client) =>
    DATA_REGIONS.map((data) => {
      const own = pairs.filter((p) => p.client === client && p.data === data);
      return [client, data, Object.fromEntries(OPS.map((op) => [op, opFigures(own, op, key)]))];
    }),
  );
};

export function latencyTable(records, key) {
  const head = `| Client | Data | ${OPS.map((o) => OP_NAMES[o]).join(' | ')} |\n|---|---|${OPS.map(() => '---').join('|')}|`;
  const rows = pairRows(records, key).map(([client, data, ops]) => `| ${CLIENTS[client].label} | ${data} | ${OPS.map((o) => cell(ops[o].spread) + (ops[o].failed ? ` (${ops[o].failed} failed)` : '')).join(' | ')} |`);
  return [head, ...rows].join('\n');
}

/** Where objects landed: for each hint, each colo seen and how many repositories. */
export function placementTable(records) {
  const pieces = ['authority', 'shard', 'combiner', 'head', 'projector'];
  const pairs = pairsOf(records);
  const rows = DATA_REGIONS.map((data) => {
    const own = pairs.filter((p) => p.data === data && p.where && !p.where.failed);
    const seen = pieces.map((piece) => {
      const counts = {};
      for (const p of own) {
        const colo = p.where[piece] ?? 'unread';
        counts[colo] = (counts[colo] ?? 0) + 1;
      }
      return Object.entries(counts).map(([colo, n]) => `${colo} ×${n}`).join(', ') || 'not measured';
    });
    return `| ${data} | ${own.length} | ${seen.join(' | ')} |`;
  });
  return ['| Hint | Repositories | Authority | First shard | Main combiner | Head holder | Projector |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
}

/** Each piece as one read from each client, through a binding: no pinned Worker in the way. */
export function pieceTable(records) {
  const probes = records.flatMap((r) => r.result?.probes ?? []);
  const names = [...new Set(probes.flatMap((p) => Object.keys(p.pieces ?? {})))];
  const clients = Object.keys(CLIENTS);
  const rows = names.map((name) => {
    const cells = clients.map((client) => cell(spread(probes.filter((p) => p.client === client).map((p) => median(p.pieces?.[name]?.ms ?? [])))));
    return `| ${name} | ${cells.join(' | ')} |`;
  });
  return [`| Piece, one read | ${clients.map((c) => CLIENTS[c].label).join(' | ')} |`, `|---|${clients.map(() => '---').join('|')}|`, ...rows].join('\n');
}

export function clientTable(records) {
  const placed = records.at(-1)?.result?.clients ?? {};
  const served = records.flatMap((r) => r.result?.probes ?? []).map((p) => p.d1?.served_by_region).filter(Boolean);
  const rows = Object.entries(placed).map(([name, c]) => `| ${CLIENTS[name].label} | ${CLIENTS[name].placed} | ${c.colo} | ${c.loc} |`);
  return [...['| Client | Placed near | Ran in colo | Country |', '|---|---|---|---|'], ...rows, '', `D1 reads served by: ${[...new Set(served)].join(', ') || 'not measured'}.`].join('\n');
}

/** Real Git from this machine, for comparing with the request forms. */
export function macTable(records) {
  const rows = records.flatMap((r) => r.result?.mac_git ?? []);
  const lines = DATA_REGIONS.flatMap((data) =>
    'clone push'.split(' ').map((op) => {
      const own = rows.filter((r) => r.data === data && r.op === op);
      return `| ${data} | ${op} | ${cell(spread(own.filter((r) => r.ok).map((r) => r.ms)))} | ${own.filter((r) => !r.ok).length} |`;
    }),
  );
  return ['| Data | Git, from the Mac | ms | Failed |', '|---|---|---|---|', ...lines].join('\n');
}

export function renderRegionResults(records) {
  if (!records.length) return 'None yet.';
  const runs = records.reduce((n, r) => n + (r.result?.runs ?? 0), 0);
  return [
    `${runs} runs, last at \`${records.at(-1).revision.slice(0, 8)}\`, ${records.at(-1).recorded_at.slice(0, 10)}. Cells: median of run medians in ms (min–max of run medians).`,
    '',
    '**Clients**',
    '',
    clientTable(records),
    '',
    '**Where objects landed**',
    '',
    placementTable(records),
    '',
    '**Client time, through the pinned platform Worker**',
    '',
    latencyTable(records, 'ms'),
    '',
    '**Server time (`Server-Timing` total), through the pinned platform Worker**',
    '',
    latencyTable(records, 'server'),
    '',
    '**Each piece from each region, one read through a binding**',
    '',
    pieceTable(records),
    '',
    '**Real Git from the Mac**',
    '',
    macTable(records),
  ].join('\n');
}

export function replaceRegionResults(doc, table) {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < start) throw new Error('The region results markers are missing from docs/global-scale-plan.md');
  return `${doc.slice(0, start + START.length)}\n${table}\n${doc.slice(end)}`;
}

export async function regionRecords(dir = EVIDENCE_DIR) {
  const names = (await readdir(resolve(dir)).catch(() => [])).filter((n) => n.startsWith('region-matrix-') && n.endsWith('.json')).sort();
  return Promise.all(names.map(async (n) => JSON.parse(await readFile(resolve(dir, n), 'utf8'))));
}

/** Rebuilds the doc's tables from every matrix evidence file. */
export async function updateRegionResults(dir = EVIDENCE_DIR, doc = DOC) {
  const records = await regionRecords(dir);
  await writeFile(doc, replaceRegionResults(await readFile(doc, 'utf8'), renderRegionResults(records)));
  return records.length;
}
