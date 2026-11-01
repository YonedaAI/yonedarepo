// Compares what Basin holds with the repository's log, version by version: no network here. The
// log is the authority, so every version it has in a window must have one `land` row in the
// table, of the same kind and commit. Basin may lag, so a window stops short of the cursor and
// of anything newer than the settle time. It may also have gaps that were decided and logged, so
// a window starts after the last of them, and after the first version the stream ever sent.
import { LANDING_KINDS } from './landing.mjs';

const landing = (kind) => LANDING_KINDS.includes(kind);

/** Versions to compare: `(from, until]`. `null` when there is nothing to compare yet. */
export function windowOf({ rows, cursor, headOfLog, settledBefore }) {
  const versions = rows.map((r) => r.version).filter(Number.isFinite);
  if (!versions.length || !cursor) return null;
  const from = Math.max(Math.min(...versions) - 1, cursor.last_gap?.to ?? 0);
  const until = Math.min(cursor.version ?? 0, headOfLog ?? Infinity, settledBefore ?? Infinity);
  return until > from ? { from, until } : null;
}

/** The newest version committed before `at`; entries are in version order. */
export function settledVersion(entries, at) {
  let version = 0;
  for (const e of entries) if (e.committed_at_ms <= at) version = e.version;
  return version;
}

/**
 * One repository's comparison. `entries` are its log in the window and `rows` the table's rows
 * for it. The log doesn't list the commits a batch merged, so a version's `merged` rows are held
 * to the count its own `land` row states; both come from the authority's `landings` table.
 */
export function compareRepo({ entries, rows, window }) {
  const inWindow = rows.filter((r) => r.version > window.from && r.version <= window.until);
  const lands = new Map();
  const duplicates = [];
  const merged = new Map();
  for (const r of inWindow) {
    if (r.event === 'merged') merged.set(r.version, (merged.get(r.version) ?? 0) + 1);
    else if (r.event === 'land') {
      if (lands.has(r.version)) duplicates.push(r.version);
      lands.set(r.version, r);
    }
  }
  const known = new Set(entries.map((e) => e.version));
  const missing = [];
  const wrong = [];
  const mergedWrong = [];
  let logLandings = 0;
  let basinLandings = 0;
  for (const entry of entries) {
    const row = lands.get(entry.version);
    const count = merged.get(entry.version) ?? 0;
    if (!row) {
      missing.push(entry.version);
      if (landing(entry.kind)) logLandings += 1;
      continue;
    }
    if (row.kind !== entry.kind || (entry.new ?? null) !== (row.commit ?? null)) wrong.push(entry.version);
    if ((row.merged_landings ?? 0) !== count) mergedWrong.push(entry.version);
    if (count > 0) {
      logLandings += row.merged_landings ?? 0;
      basinLandings += count;
    } else if (landing(entry.kind)) {
      logLandings += 1;
      if (landing(row.kind)) basinLandings += 1;
    }
  }
  const extra = [...lands.keys()].filter((v) => !known.has(v));
  return { window, log_versions: entries.length, log_landings: logLandings, basin_landings: basinLandings, drift: logLandings - basinLandings, missing, extra, wrong, merged_wrong: mergedWrong, duplicates };
}

const TROUBLE = ['missing', 'extra', 'wrong', 'merged_wrong'];
export const hasTrouble = (repo) => repo.sent_without_rows === true || Boolean(repo.window && (repo.drift !== 0 || TROUBLE.some((key) => repo[key].length)));

/** A check's whole answer. Passing needs enough compared to mean something: a quiet dev proves
 * nothing, and neither does a table of repositories that were deleted. */
export function summarize(repos, { minLandings }) {
  const compared = repos.filter((r) => r.window);
  const landings = compared.reduce((n, r) => n + r.log_landings, 0);
  const drift = compared.reduce((n, r) => n + r.drift, 0);
  const trouble = repos.filter(hasTrouble).map((r) => r.repo);
  const verdict = trouble.length ? 'fail' : landings >= minLandings ? 'pass' : 'too_few';
  return {
    verdict,
    repositories_compared: compared.length,
    versions_compared: compared.reduce((n, r) => n + r.log_versions, 0),
    landings_in_log: landings,
    landings_in_basin: compared.reduce((n, r) => n + r.basin_landings, 0),
    drift,
    drift_pct: landings ? Number(((100 * Math.abs(drift)) / landings).toFixed(3)) : null,
    trouble,
    gaps: repos.reduce((n, r) => n + (r.cursor?.gaps ?? 0), 0),
    send_failures: repos.reduce((n, r) => n + (r.cursor?.failures ?? 0), 0),
  };
}
