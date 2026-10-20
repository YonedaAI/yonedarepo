// Tail counters inside the ledger: per-minute rows merged as batches arrive, read back as
// one window per component. Rows older than two days and all but the newest samples are
// pruned on write, so storage stays bounded under any traffic.
import {
  emptyHist,
  mergeHist,
  p95,
  type TailComponent,
  type TailRow,
  type TailStats,
} from './tail';

const KEEP_MS = 48 * 60 * 60_000;
const KEEP_SAMPLES = 100;
const SAMPLES_PER_WINDOW = 3;
const COUNTERS = [
  'invocations',
  'errors',
  'exceptions',
  'resource_kills',
  'error_logs',
  'push_retries',
] as const;

export function ingestRows(sql: SqlStorage, rows: TailRow[], now: number) {
  for (const r of rows) {
    const old = sql
      .exec<{ hist: string }>(
        'SELECT hist FROM tail_minutes WHERE minute = ? AND component = ?',
        r.minute,
        r.component,
      )
      .toArray()[0];
    const hist = mergeHist(old ? JSON.parse(old.hist) : emptyHist(), r.hist);
    sql.exec(
      `INSERT INTO tail_minutes (minute, component, invocations, errors, exceptions, resource_kills, error_logs, push_retries, hist)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(minute, component) DO UPDATE SET
         invocations = invocations + excluded.invocations, errors = errors + excluded.errors,
         exceptions = exceptions + excluded.exceptions, resource_kills = resource_kills + excluded.resource_kills,
         error_logs = error_logs + excluded.error_logs, push_retries = push_retries + excluded.push_retries,
         hist = excluded.hist`,
      r.minute,
      r.component,
      r.invocations,
      r.errors,
      r.exceptions,
      r.resourceKills,
      r.errorLogs,
      r.pushRetries,
      JSON.stringify(hist),
    );
    for (const s of r.samples)
      sql.exec(
        'INSERT INTO tail_samples (minute, component, name, message) VALUES (?, ?, ?, ?)',
        r.minute,
        r.component,
        s.name,
        s.message,
      );
  }
  sql.exec('DELETE FROM tail_minutes WHERE minute < ?', now - KEEP_MS);
  sql.exec(
    'DELETE FROM tail_samples WHERE id <= (SELECT id FROM tail_samples ORDER BY id DESC LIMIT 1 OFFSET ?)',
    KEEP_SAMPLES,
  );
}

/** Per-component totals for minutes in [start, end); components without events are absent. */
export function tailWindow(sql: SqlStorage, start: number, end: number) {
  const sums = new Map<TailComponent, { counts: Record<string, number>; hist: number[] }>();
  let events = 0;
  for (const r of sql
    .exec<Record<string, any>>(
      'SELECT * FROM tail_minutes WHERE minute >= ? AND minute < ?',
      start,
      end,
    )
    .toArray()) {
    const sum = sums.get(r.component) ?? { counts: {}, hist: emptyHist() };
    for (const key of COUNTERS) sum.counts[key] = (sum.counts[key] ?? 0) + r[key];
    sum.hist = mergeHist(sum.hist, JSON.parse(r.hist));
    sums.set(r.component, sum);
    events += r.invocations;
  }
  const components: Partial<Record<TailComponent, TailStats>> = {};
  for (const [component, { counts, hist }] of sums)
    components[component] = {
      invocations: counts.invocations,
      errors: counts.errors,
      exceptions: counts.exceptions,
      resourceKills: counts.resource_kills,
      errorLogs: counts.error_logs,
      pushRetries: counts.push_retries,
      p95WallMs: p95(hist),
      samples: sql
        .exec<{ name: string; message: string }>(
          'SELECT name, message FROM tail_samples WHERE component = ? AND minute >= ? AND minute < ? ORDER BY id DESC LIMIT ?',
          component,
          start,
          end,
          SAMPLES_PER_WINDOW,
        )
        .toArray(),
    };
  return { events, components };
}
