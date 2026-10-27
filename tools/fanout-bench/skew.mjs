// Write skew (C9): a burst of writers on main, each writing its own file and declaring a
// read of the files its next `k` neighbours write (writer i reads i+1..i+k, mod n), so
// every batch holds members whose reads meet other members' writes. The same burst runs
// without declared reads for the latency cost. Each landed write is then checked against
// the log: no entry landed between its base and its own version may have written what it
// read (backward validation; any such entry is a serializability violation).
import { AUTHOR, b64 } from './driver.mjs';
import { errors, ok, percentiles, phases } from './stats.mjs';

/** Equal, or one a `dir/` prefix or parent directory of the other (occ.rs `overlaps`). */
export function overlaps(a, b) {
  const within = (inner, outer) => (outer.endsWith('/') && inner.startsWith(outer)) || (inner.length > outer.length && inner.startsWith(outer) && inner[outer.length] === '/');
  return a === b || within(a, b) || within(b, a);
}

const PATH_KINDS = ['commit', 'merge', 'changeset'];

/** Landed writes (`{commit, base_version, version, read_set}`) whose reads an entry landed
 * after their base and before them wrote. A symbol read (`path#symbol`) counts as its whole
 * file here, which is stricter than the platform; a ref move without paths meets every read. */
export function violations(landed, entries, refname = 'refs/heads/main') {
  const found = [];
  for (const w of landed) {
    const reads = (w.read_set ?? []).map((r) => r.split('#')[0]);
    if (!reads.length) continue;
    for (const e of entries) {
      if (e.refname !== refname || e.version <= w.base_version || e.version >= w.version) continue;
      const opaque = !e.paths.length && !PATH_KINDS.includes(e.kind);
      const paths = opaque ? ['(ref move without paths)'] : e.paths.map((p) => p.path).filter((p) => reads.some((r) => overlaps(r, p)));
      if (paths.length) found.push({ commit: w.commit, base_version: w.base_version, version: w.version, by_version: e.version, paths });
    }
  }
  return found;
}

/** The log's own record of each entry with declared reads, in `violations` form. */
export const loggedReads = (entries) =>
  entries.filter((e) => e.read_set?.length).map((e) => ({ commit: e.new, base_version: e.base_version, version: e.version, read_set: e.read_set }));

/** Waits until main's published head (what commits begin from) holds `version`. */
async function published(session, repo, path, version) {
  for (const started = Date.now(); Date.now() - started < 30_000; ) {
    const { status, body } = await session.call('GET', `/repos/${repo}/blob?path=${encodeURIComponent(path)}`);
    if (status === 200 && body.version >= version) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const READ_CONFLICT = (r) => r?.status === 409 && r.error === 'CONFLICT' && /read/.test(r.message ?? '');

async function phase(session, repo, tokens, { n, k, reads, label, mode }) {
  const dir = `skew/${label}`;
  const seed = await session.post(`/repos/${repo}/commits`, {
    ref: 'main',
    changes: Array.from({ length: n }, (_, i) => ({ path: `${dir}/${i}.txt`, content_b64: b64(`${label} ${i} v0\n`) })),
    message: `seed ${dir}`,
    author: AUTHOR,
  });
  const seeded = await session.post(`/repos/${repo}/land`, { ref: 'main', commit: seed.commit });
  const headCaughtUp = await published(session, repo, `${dir}/0.txt`, seeded.version);
  const writers = Array.from({ length: n }, (_, i) => ({
    token: tokens[i],
    mode,
    path: `${dir}/${i}.txt`,
    content: `${label} ${i} v1\n`,
    ...(reads ? { read_set: Array.from({ length: k }, (_, d) => `${dir}/${(i + d + 1) % n}.txt`) } : {}),
  }));
  const began = performance.now();
  const results = await session.fanout(repo, writers);
  const elapsed = performance.now() - began;

  const landedRows = results.map((r, i) => ({ r, w: writers[i] })).filter(({ r }) => ok(r.land));
  const landed = landedRows.map(({ r, w }) => ({ commit: r.commit.commit, base_version: r.commit.base_version, version: r.land.version, read_set: w.read_set ?? [] }));
  const unchecked = landed.filter((l) => !Number.isInteger(l.base_version) || !Number.isInteger(l.version)).length;
  const checkable = landed.filter((l) => Number.isInteger(l.base_version) && Number.isInteger(l.version));
  const after = checkable.reduce((m, l) => Math.min(m, l.base_version), seeded.version);
  const until = checkable.reduce((m, l) => Math.max(m, l.version), seeded.version);
  const { entries, refused } = await session.txlog(repo, after, until);
  const clientView = violations(checkable, entries);
  // Entries on main inside landed readers' windows: what the check examined (0 = vacuous).
  const examined = checkable
    .filter((l) => l.read_set.length)
    .reduce((n, l) => n + entries.filter((e) => e.refname === 'refs/heads/main' && e.version > l.base_version && e.version < l.version).length, 0);
  const logView = violations(loggedReads(entries), entries);

  const failed = results.filter((r) => !ok(r.land)).map((r) => (ok(r.commit) ? r.land : r.commit));
  const lands = landedRows.map(({ r }) => r.land);
  return {
    phase: reads ? 'reads' : 'plain',
    writers: n,
    reads_per_writer: reads ? k : 0,
    seed_version: seeded.version,
    head_caught_up: headCaughtUp,
    elapsed_ms: Math.round(elapsed),
    landed: landed.length,
    read_conflicts: failed.filter(READ_CONFLICT).length,
    other_failures: errors(failed.filter((f) => !READ_CONFLICT(f))),
    commit: percentiles(results.filter((r) => ok(r.commit)).map((r) => r.commit.ms)),
    land: percentiles(lands.map((l) => l.ms)),
    total: percentiles(landedRows.map(({ r }) => r.commit.ms + r.land.ms)),
    // Batch deferrals are not reported to the lander; time queued (which includes them)
    // is the visible proxy.
    land_phases: phases(lands),
    serializable: {
      checked: checkable.length,
      unchecked,
      log_entries: entries.length,
      examined,
      txlog_refused: refused,
      violations: clientView.length,
      log_violations: logView.length,
      examples: [...clientView, ...logView].slice(0, 5),
    },
  };
}

export async function skew(session, { writers: n, k, runs, mode }) {
  if (k >= n) throw new Error('--skew-reads must be below --writers');
  const repo = await session.createRepo(`skew${n}`, [{ path: 'README.md', content_b64: b64('write skew\n') }]);
  const tokens = await session.mintTokens(repo, n);
  const out = [];
  for (let run = 0; run < runs; run++) {
    // Alternate which goes first, so neither phase always meets the warmer platform.
    const order = run % 2 ? [true, false] : [false, true];
    const phasesRun = {};
    for (const reads of order) {
      const result = await phase(session, repo, tokens, { n, k, reads, label: `run${run}-${reads ? 'reads' : 'plain'}`, mode });
      phasesRun[result.phase] = result;
      console.error(`run ${run} ${result.phase}: landed ${result.landed}/${n}, read conflicts ${result.read_conflicts}, violations ${result.serializable.violations}+${result.serializable.log_violations}`);
    }
    const { plain, reads } = phasesRun;
    const delta = (key, p) => (reads[key][p] ?? 0) - (plain[key][p] ?? 0);
    out.push({ ...phasesRun, cost_ms: { land_p50: delta('land', 'p50_ms'), land_p95: delta('land', 'p95_ms'), total_p50: delta('total', 'p50_ms'), total_p95: delta('total', 'p95_ms') } });
  }
  const violationsTotal = out.reduce((n, r) => n + r.plain.serializable.violations + r.reads.serializable.violations + r.plain.serializable.log_violations + r.reads.serializable.log_violations, 0);
  return { repo, writers: n, reads_per_writer: k, runs, mode: mode ?? 'default', serializable: violationsTotal === 0, violations: violationsTotal, results: out };
}
