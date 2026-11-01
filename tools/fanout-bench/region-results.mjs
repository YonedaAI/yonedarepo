// The results tables of docs/global-scale-plan.md, rebuilt from the evidence files, never typed:
// for each region and path, each operation's median in each run, then the min, median and max of
// those medians, and what each operation still reached. A failed sample is counted, never averaged.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_DIR } from './driver.mjs';
import { CLIENTS } from './regions.mjs';
import { spread } from './results.mjs';

const START = '<!-- region-results:start (tools/platform-region-matrix.mjs --results) -->';
const END = '<!-- region-results:end -->';
const DOC = fileURLToPath(new URL('../../docs/global-scale-plan.md', import.meta.url));
export const OPS = ['page', 'asset', 'sign_in', 'read_token', 'read_pat', 'list', 'search', 'clone', 'commit', 'land', 'push', 'create'];
const OP_NAMES = { page: 'Page', asset: 'Asset', sign_in: 'Sign-in', read_token: 'Read, repo token', read_pat: 'Read, personal token', list: 'List', search: 'Search', clone: 'Clone', commit: 'Commit', land: 'Land', push: 'Push', create: 'Create' };
const ARMS = ['today', 'region'];
/** Hops whose far end we know stays with the client: the object started there, and `/where` says
 * so in the table above. The rest are named as they were counted, and judged in the doc. */
const HOP = /hop\.([a-z0-9]+);dur=([\d.]+);desc="(\d+)"/g;

const median = (values) => spread(values)?.median ?? null;
/** A repository's own authority, however many commands reached it. */
const AUTHORITY = /do\.[a-z_]+;dur=([\d.]+);desc="(\d+)"/g;
const cell = (s) => (s ? `${Math.round(s.median)} (${Math.round(s.min)}–${Math.round(s.max)})` : 'not measured');
const armsOf = (records) => records.flatMap((r) => r.result?.arms ?? []);

/** An arm's figures for one op: the spread of each run's median, and how many samples failed.
 * The first read of a run is its cold one, kept apart. */
function opFigures(arms, op, key) {
  const runs = arms.map((p) => (p.ops?.[op] ?? []).filter((r, i) => r.ok && r[key] !== null && r[key] !== undefined && (!op.startsWith('read') || i > 0)).map((r) => r[key]));
  return { spread: spread(runs.map(median)), failed: arms.flatMap((p) => p.ops?.[op] ?? []).filter((r) => !r.ok).length };
}

export function latencyTable(records, key) {
  const arms = armsOf(records);
  const head = `| Client | Path | ${OPS.map((o) => OP_NAMES[o]).join(' | ')} |\n|---|---|${OPS.map(() => '---').join('|')}|`;
  const rows = Object.keys(CLIENTS).flatMap((client) =>
    ARMS.map((arm) => {
      const own = arms.filter((p) => p.client === client && p.arm === arm);
      const cells = OPS.map((op) => {
        const f = opFigures(own, op, key);
        return cell(f.spread) + (f.failed ? ` (${f.failed} failed)` : '');
      });
      return `| ${CLIENTS[client].label} | ${arm === 'today' ? 'Today' : `In region, ${own[0]?.data ?? CLIENTS[client].near}`} | ${cells.join(' | ')} |`;
    }),
  );
  return [head, ...rows].join('\n');
}

/** What one op reached, from its `hop.*` phases: mean calls and median time per answer. */
export function hopsOf(rows) {
  const seen = new Map();
  for (const row of rows.filter((r) => r.ok))
    for (const [, name, dur, count] of (row.timing ?? '').matchAll(HOP)) {
      const hop = seen.get(name) ?? { calls: 0, ms: [] };
      hop.calls += Number(count);
      hop.ms.push(Number(dur));
      seen.set(name, hop);
    }
  for (const row of rows.filter((r) => r.ok)) {
    const calls = [...(row.timing ?? '').matchAll(AUTHORITY)];
    if (!calls.length) continue;
    const hop = seen.get('repository') ?? { calls: 0, ms: [] };
    hop.calls += calls.reduce((n, m) => n + Number(m[2]), 0);
    hop.ms.push(calls.reduce((n, m) => n + Number(m[1]), 0));
    seen.set('repository', hop);
  }
  const answers = rows.filter((r) => r.ok).length;
  return Object.fromEntries([...seen].map(([name, hop]) => [name, { calls: Number((hop.calls / answers).toFixed(1)), ms: Math.round(median(hop.ms)) }]));
}

const hopText = (hops) => Object.entries(hops).map(([name, h]) => `${name} ${h.calls}× ${h.ms} ms`).join(', ') || 'none';

/** For each op on the region's path: each piece it still reached, by client. */
export function hopTable(records) {
  const arms = armsOf(records).filter((p) => p.arm === 'region');
  const clients = Object.keys(CLIENTS);
  const rows = OPS.filter((op) => arms.some((p) => p.ops?.[op])).map((op) => {
    const cells = clients.map((client) => hopText(hopsOf(arms.filter((p) => p.client === client).flatMap((p) => p.ops?.[op] ?? []))));
    return `| ${OP_NAMES[op]} | ${cells.join(' | ')} |`;
  });
  return [`| Operation | ${clients.map((c) => CLIENTS[c].label).join(' | ')} |`, `|---|${clients.map(() => '---').join('|')}|`, ...rows].join('\n');
}

/** Where objects landed: for each arm and region, each colo seen and how many repositories. */
export function placementTable(records) {
  const pieces = ['worker', 'authority', 'shard', 'combiner', 'head', 'projector', 'account'];
  const arms = armsOf(records);
  const rows = Object.keys(CLIENTS).flatMap((client) =>
    ARMS.map((arm) => {
      const own = arms.filter((p) => p.client === client && p.arm === arm && p.where && !p.where.failed);
      const seen = pieces.map((piece) => {
        const counts = {};
        for (const p of own) {
          const colo = p.where[piece] ?? 'unread';
          counts[colo] = (counts[colo] ?? 0) + 1;
        }
        return Object.entries(counts).map(([colo, n]) => `${colo} ×${n}`).join(', ') || 'not measured';
      });
      return `| ${CLIENTS[client].label} | ${arm} | ${own[0]?.data ?? '–'} | ${seen.join(' | ')} |`;
    }),
  );
  return ['| Client | Path | Hint | Code ran in | Authority | First shard | Main combiner | Head holder | Projector | Account |', '|---|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}

/** Each piece as one call from each client, through a binding: no pinned Worker in the way. */
export function pieceTable(records) {
  const probes = records.flatMap((r) => r.result?.probes ?? []);
  const names = [...new Set(probes.flatMap((p) => Object.keys(p.pieces ?? {})))];
  const clients = Object.keys(CLIENTS);
  const rows = names.map((name) => {
    const cells = clients.map((client) => cell(spread(probes.filter((p) => p.client === client).map((p) => median(p.pieces?.[name]?.ms ?? [])))));
    return `| ${name} | ${cells.join(' | ')} |`;
  });
  return [`| Piece, one call | ${clients.map((c) => CLIENTS[c].label).join(' | ')} |`, `|---|${clients.map(() => '---').join('|')}|`, ...rows].join('\n');
}

export function clientTable(records) {
  const placed = records.at(-1)?.result?.clients ?? {};
  const rows = Object.entries(placed).map(([name, c]) => `| ${CLIENTS[name].label} | ${CLIENTS[name].placed} | ${c.colo} |`);
  return ['| Client | Placed near | Ran in colo |', '|---|---|---|', ...rows].join('\n');
}

/** D1 reads through a session, by the place that answered each one. */
export function replicaTable(records) {
  const probes = records.flatMap((r) => r.result?.probes ?? []);
  const rows = Object.keys(CLIENTS).map((client) => {
    const byRegion = {};
    for (const p of probes.filter((q) => q.client === client))
      for (const [region, ms] of Object.entries(p.d1_session ?? {})) if (Array.isArray(ms)) (byRegion[region] ??= []).push(...ms);
    const text = Object.entries(byRegion).map(([region, ms]) => `${region}: ${ms.length} reads, median ${median(ms)} ms`).join('; ');
    return `| ${CLIENTS[client].label} | ${text || 'not measured'} |`;
  });
  return ['| Client | Answered by |', '|---|---|', ...rows].join('\n');
}

/** Real Git from this machine, on today's path: Git can't reach the region's. */
export function macTable(records) {
  const rows = records.flatMap((r) => r.result?.mac_git ?? []);
  const lines = 'clone push'.split(' ').map((op) => {
    const own = rows.filter((r) => r.op === op);
    return `| ${op} | ${cell(spread(own.filter((r) => r.ok).map((r) => r.ms)))} | ${own.filter((r) => !r.ok).length} |`;
  });
  return ['| Git, from the Mac | ms | Failed |', '|---|---|---|', ...lines].join('\n');
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
    '**Where it ran**',
    '',
    placementTable(records),
    '',
    '**What each operation still reached, on the region\'s path** (calls per answer, median time)',
    '',
    hopTable(records),
    '',
    '**Client time**',
    '',
    latencyTable(records, 'ms'),
    '',
    '**Server time (`Server-Timing` total)**',
    '',
    latencyTable(records, 'server'),
    '',
    '**Each piece from each region, one call through a binding**',
    '',
    pieceTable(records),
    '',
    '**D1 through a session, with read replication on**',
    '',
    replicaTable(records),
    '',
    '**Real Git from the Mac**',
    '',
    macTable(records),
  ].join('\n');
}

/** Runs the doc's tables stand on: a rebuild from fewer would lose results. */
const runsIn = (block) => Number(/(\d+) runs, last at/.exec(block)?.[1] ?? 0);

export function replaceRegionResults(doc, table) {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < start) throw new Error('The region results markers are missing from docs/global-scale-plan.md');
  const held = runsIn(doc.slice(start, end));
  if (runsIn(table) < held) throw new Error(`The doc stands on ${held} runs and the evidence here on ${runsIn(table)}: not replacing it`);
  return `${doc.slice(0, start + START.length)}\n${table}\n${doc.slice(end)}`;
}

export async function regionRecords(dir = EVIDENCE_DIR) {
  const names = (await readdir(resolve(dir)).catch(() => [])).filter((n) => /^region-(matrix|probe)-.*\.json$/.test(n)).sort();
  return Promise.all(names.map(async (n) => JSON.parse(await readFile(resolve(dir, n), 'utf8'))));
}

/** Rebuilds the doc's tables from every matrix evidence file. */
export async function updateRegionResults(dir = EVIDENCE_DIR, doc = DOC) {
  const records = await regionRecords(dir);
  await writeFile(doc, replaceRegionResults(await readFile(doc, 'utf8'), renderRegionResults(records)));
  return records.length;
}
