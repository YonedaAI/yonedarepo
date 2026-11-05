// Response-ready latency and invocation lifetime are separate series. Only comparable,
// successful, unmarked page/API traffic trains them. These are detector learning requirements,
// not a claimed product SLO. Sparse traffic remains explicitly uncalibrated.
import type { HttpMetric } from './http-timing';
import { emptyHist, mergeHist, p95 } from './tail';

export const LATENCY_WINDOW_MS = 5 * 60_000;
export const LATENCY_MIN_REQUESTS = 100; // At least five samples in the estimated upper 5%.
export const LATENCY_BASELINE_WINDOWS = 24;
export const LATENCY_BASELINE_SPAN_MS = 24 * 60 * 60_000;
const HISTORY_MS = 7 * LATENCY_BASELINE_SPAN_MS;
const SERIES = ['page', 'api'] as const;

export interface HttpLatency {
  traffic: 'page' | 'api';
  metric: HttpMetric;
  window_end: number;
  requests: number;
  p95_ms: number | null;
  required_requests: number;
  required_baseline_windows: number;
  baseline_windows: number;
  baseline_span_ms: number;
  baseline_hours: number;
  baseline_ms: number | null;
  threshold_ms: number | null;
  status: 'learning' | 'insufficient_traffic' | 'ready';
  anomalous: boolean;
}
interface WindowRow extends Record<string, SqlStorageValue> {
  window_end: number;
  requests: number;
  p95_ms: number;
  bad: number;
}
const quantile = (values: number[], q: number) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * q) - 1)];
};

/** UTC-aligned closed windows: polling one window repeatedly cannot train or trigger twice. */
export function httpLatency(sql: SqlStorage, now: number, record = true): HttpLatency[] {
  const end = Math.floor(now / LATENCY_WINDOW_MS) * LATENCY_WINDOW_MS;
  const start = end - LATENCY_WINDOW_MS;
  const grouped = new Map<string, number[]>();
  for (const row of sql
    .exec<{ traffic: string; metric: string; hist: string }>(
      'SELECT traffic,metric,hist FROM http_latency_minutes WHERE minute>=? AND minute<?',
      start,
      end,
    )
    .toArray()) {
    const key = `${row.traffic}/${row.metric}`;
    grouped.set(key, mergeHist(grouped.get(key) ?? emptyHist(), JSON.parse(row.hist)));
  }
  const result: HttpLatency[] = [];
  for (const traffic of SERIES)
    for (const metric of ['response', 'execution'] as const) {
      const hist = grouped.get(`${traffic}/${metric}`) ?? emptyHist();
      const requests = hist.reduce((sum, n) => sum + n, 0);
      const value = p95(hist);
      const history = sql
        .exec<WindowRow>(
          'SELECT window_end,requests,p95_ms,bad FROM latency_windows WHERE traffic=? AND metric=? AND window_end<? AND window_end>=? AND requests>=? AND bad=0 ORDER BY window_end',
          traffic,
          metric,
          end,
          end - HISTORY_MS,
          LATENCY_MIN_REQUESTS,
        )
        .toArray();
      const span = history.length ? end - history[0].window_end : 0;
      const hours = new Set(history.map((r) => Math.floor(r.window_end / 3_600_000))).size;
      const trained = hours >= LATENCY_BASELINE_WINDOWS && span >= LATENCY_BASELINE_SPAN_MS;
      const baseline = trained
        ? quantile(
            history.map((r) => r.p95_ms),
            0.5,
          )
        : null;
      // One full histogram bucket beyond the historical upper band. A bucket's 1.5x
      // uncertainty alone must not become a slowdown; no invented fixed millisecond SLO.
      const threshold = trained
        ? Math.ceil(
            quantile(
              history.map((r) => r.p95_ms),
              0.95,
            ) * 1.5,
          )
        : null;
      const enough = requests >= LATENCY_MIN_REQUESTS && value !== null;
      const bad = Boolean(enough && threshold !== null && value > threshold);
      const previous = sql
        .exec<WindowRow>(
          'SELECT window_end,requests,p95_ms,bad FROM latency_windows WHERE traffic=? AND metric=? AND window_end=?',
          traffic,
          metric,
          start,
        )
        .toArray()[0];
      result.push({
        traffic,
        metric,
        window_end: end,
        requests,
        p95_ms: value,
        required_requests: LATENCY_MIN_REQUESTS,
        required_baseline_windows: LATENCY_BASELINE_WINDOWS,
        baseline_windows: history.length,
        baseline_span_ms: span,
        baseline_hours: hours,
        baseline_ms: baseline,
        threshold_ms: threshold,
        status: !trained ? 'learning' : !enough ? 'insufficient_traffic' : 'ready',
        anomalous: bad && previous?.bad === 1 && previous.requests >= LATENCY_MIN_REQUESTS,
      });
      if (record)
        sql.exec(
          'INSERT INTO latency_windows VALUES (?,?,?,?,?,?) ON CONFLICT(traffic,metric,window_end) DO UPDATE SET requests=excluded.requests,p95_ms=excluded.p95_ms,bad=excluded.bad',
          traffic,
          metric,
          end,
          requests,
          value,
          bad ? 1 : 0,
        );
    }
  if (record) sql.exec('DELETE FROM latency_windows WHERE window_end<?', end - HISTORY_MS);
  return result;
}
