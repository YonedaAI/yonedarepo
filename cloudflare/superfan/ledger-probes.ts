// Synthetic results inside Superfan's ledger, kept two days. Recording a pass answers with each
// check's latest results, which is all a pass needs, so a healthy pass stays one call.
import { PROBE_CHECKS, type ProbeCheck, type ProbeResult } from './synthetic-checks';

const KEEP_MS = 48 * 60 * 60_000;
/** Results of one check a pass reads: how many in a row must fail (synthetic.ts). */
const LATEST = 2;

export interface ProbeRow {
  at: number;
  ok: number;
  status: number | null;
}
export type LatestProbes = Partial<Record<ProbeCheck, ProbeRow[]>>;

export function recordProbes(sql: SqlStorage, results: ProbeResult[], now: number): LatestProbes {
  for (const r of results)
    sql.exec(
      'INSERT INTO probe_results (at, check_name, ok, status, ms, detail, revision) VALUES (?, ?, ?, ?, ?, ?, ?)',
      now,
      r.check,
      r.ok ? 1 : 0,
      r.status,
      r.ms,
      r.detail,
      r.revision,
    );
  sql.exec('DELETE FROM probe_results WHERE at < ?', now - KEEP_MS);
  const latest: LatestProbes = {};
  for (const check of PROBE_CHECKS)
    latest[check] = sql
      .exec<Record<keyof ProbeRow, SqlStorageValue>>(
        'SELECT at, ok, status FROM probe_results WHERE check_name = ? ORDER BY at DESC, id DESC LIMIT ?',
        check,
        LATEST,
      )
      .toArray() as unknown as ProbeRow[];
  return latest;
}

export const recentProbes = (sql: SqlStorage, limit: number) =>
  sql.exec('SELECT * FROM probe_results ORDER BY at DESC, id DESC LIMIT ?', limit).toArray();
