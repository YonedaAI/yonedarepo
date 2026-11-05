// Invocation-lifetime references use independent closed UTC hours, not repeated rolling polls.

import {
  LATENCY_BASELINE_SPAN_MS,
  LATENCY_BASELINE_WINDOWS,
  LATENCY_MIN_REQUESTS,
} from './http-latency';
import { tailWindow } from './ledger-tail';
import type { Baselines } from './signal-rules';

const HOUR = 3_600_000;
const KEEP = 7 * 24 * HOUR;
const key = (traffic: string) => `${traffic.slice('worker:'.length)}/p95_wall_ms`;
const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];

export function executionBaselines(sql: SqlStorage, now: number): Baselines {
  const groups = new Map<string, { end: number; value: number }[]>();
  for (const row of sql
    .exec<{ traffic: string; window_end: number; p95_ms: number }>(
      "SELECT traffic,window_end,p95_ms FROM latency_windows WHERE traffic LIKE 'worker:%' AND metric='execution' AND window_end>=? AND requests>=? AND bad=0 ORDER BY window_end",
      now - KEEP,
      LATENCY_MIN_REQUESTS,
    )
    .toArray()) {
    const list = groups.get(row.traffic) ?? [];
    list.push({ end: row.window_end, value: row.p95_ms });
    groups.set(row.traffic, list);
  }
  return Object.fromEntries(
    [...groups].map(([traffic, rows]) => [
      key(traffic),
      {
        value: quantile(
          rows.map((r) => r.value),
          0.5,
        ),
        samples: rows.length,
        status:
          rows.length >= LATENCY_BASELINE_WINDOWS &&
          rows[rows.length - 1].end - rows[0].end >= LATENCY_BASELINE_SPAN_MS
            ? 'ready'
            : 'learning',
        windows: rows.length,
        spanMs: rows[rows.length - 1].end - rows[0].end,
        ceiling: Math.ceil(
          quantile(
            rows.map((r) => r.value),
            0.95,
          ) * 1.5,
        ),
      },
    ]),
  );
}

export function recordExecutionBaselines(sql: SqlStorage, now: number) {
  const end = Math.floor(now / HOUR) * HOUR;
  const baseline = executionBaselines(sql, now);
  for (const [component, t] of Object.entries(tailWindow(sql, end - HOUR, end).components)) {
    if (
      component === 'front_worker' ||
      component === 'backend_execution' ||
      !t ||
      t.invocations < LATENCY_MIN_REQUESTS ||
      t.p95WallMs === null ||
      t.errors ||
      t.exceptions ||
      t.resourceKills ||
      t.errorLogs
    )
      continue;
    const base = baseline[`${component}/p95_wall_ms`];
    const trained =
      base &&
      (base.windows ?? 0) >= LATENCY_BASELINE_WINDOWS &&
      (base.spanMs ?? 0) >= LATENCY_BASELINE_SPAN_MS;
    const bad = Boolean(trained && base.ceiling !== undefined && t.p95WallMs > base.ceiling);
    sql.exec(
      'INSERT INTO latency_windows VALUES (?,?,?,?,?,?) ON CONFLICT(traffic,metric,window_end) DO NOTHING',
      `worker:${component}`,
      'execution',
      end,
      t.invocations,
      t.p95WallMs,
      bad ? 1 : 0,
    );
  }
}
