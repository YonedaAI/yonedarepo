import { type HttpTraffic, httpTraffic } from '../../shared/http-traffic';
import { emptyHist, mergeHist, p95 } from './tail';

export type HttpMetric = 'response' | 'execution';
export interface HttpMinute {
  minute: number;
  traffic: HttpTraffic;
  metric: HttpMetric;
  hist: number[];
}

/** Every successful front invocation contributes at most one sample to each metric. */
export function httpTimings(events: TraceItem[], front: string): HttpMinute[] {
  const rows = new Map<string, HttpMinute>();
  for (const item of events) {
    if (item.scriptName !== front || item.executionModel === 'durableObject') continue;
    const event = item.event as Partial<TraceItemFetchEventInfo> | null;
    const request = event?.request;
    if (!request || !URL.canParse(request.url)) continue;
    const status = event?.response?.status;
    if (item.outcome !== 'ok' || !status || status < 200 || status >= 400) continue;
    const traffic = httpTraffic(request.url, request.headers?.['x-yoneda-own-traffic'] === '1');
    const minute = Math.floor((item.eventTimestamp ?? Date.now()) / 60_000) * 60_000;
    let ready: number | undefined;
    for (const line of item.logs) {
      try {
        const value =
          typeof line.message[0] === 'string' ? JSON.parse(line.message[0]) : line.message[0];
        if (
          value?.event === 'http.response' &&
          value.status === status &&
          Number.isFinite(value.elapsed_ms) &&
          value.elapsed_ms >= 0
        ) {
          ready = value.elapsed_ms;
          break;
        }
      } catch {
        /* Other logs are not timing samples. */
      }
    }
    for (const [metric, ms] of [
      ['response', ready],
      ['execution', item.wallTime],
    ] as const) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) continue;
      const key = `${minute}/${traffic}/${metric}`;
      const row = rows.get(key) ?? { minute, traffic, metric, hist: emptyHist() };
      let bucket = 0;
      while (bucket < row.hist.length - 1 && ms > 5 * 1.5 ** bucket) bucket++;
      row.hist[bucket]++;
      rows.set(key, row);
    }
  }
  return [...rows.values()];
}

export function ingestHttp(sql: SqlStorage, rows: HttpMinute[], now: number) {
  for (const row of rows) {
    const old = sql
      .exec<{ hist: string }>(
        'SELECT hist FROM http_latency_minutes WHERE minute=? AND traffic=? AND metric=?',
        row.minute,
        row.traffic,
        row.metric,
      )
      .toArray()[0];
    const hist = mergeHist(old ? JSON.parse(old.hist) : emptyHist(), row.hist);
    sql.exec(
      'INSERT INTO http_latency_minutes VALUES (?,?,?,?) ON CONFLICT(minute,traffic,metric) DO UPDATE SET hist=excluded.hist',
      row.minute,
      row.traffic,
      row.metric,
      JSON.stringify(hist),
    );
  }
  sql.exec('DELETE FROM http_latency_minutes WHERE minute < ?', now - 48 * 60 * 60_000);
}

/** Read-only operator evidence for classes excluded from baseline learning. */
export function httpTrafficStats(sql: SqlStorage, now: number) {
  const grouped = new Map<string, number[]>();
  for (const row of sql
    .exec<{ traffic: string; metric: string; hist: string }>(
      'SELECT traffic,metric,hist FROM http_latency_minutes WHERE minute>=? AND minute<?',
      now - 3_600_000,
      now,
    )
    .toArray()) {
    const key = `${row.traffic}/${row.metric}`;
    grouped.set(key, mergeHist(grouped.get(key) ?? emptyHist(), JSON.parse(row.hist)));
  }
  return [...grouped].map(([key, hist]) => ({
    traffic: key.split('/')[0],
    metric: key.split('/')[1],
    requests: hist.reduce((a, b) => a + b, 0),
    p95_ms: p95(hist),
  }));
}
