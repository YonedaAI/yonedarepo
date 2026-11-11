import { useEffect, useState } from 'react';
import type { OperationReport } from '../../../../shared/operation-metrics';
import { contentReady } from '../site/clientPerformance';
import { duration } from '../source-platform/insightsModel';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useSource } from '../source-platform/useSource';
import { figure } from './trafficModel';

const SOURCE: Record<string, string> = {
  web: 'Website',
  rest: 'API',
  mcp: 'MCP',
  git_https: 'Git HTTPS',
  git_ssh: 'Git SSH',
  queue: 'Queue',
  cron: 'Scheduled',
  workflow: 'Workflow',
  alarm: 'Alarm',
  monitor: 'Health check',
  unknown: 'Unknown',
};
const KIND: Record<string, string> = {
  request: 'Requests',
  repository: 'Repository commands',
  background: 'Background work',
  browser: 'Browser reports',
  transfer: 'Git transfers',
};
const TRAFFIC: Record<string, string> = {
  ordinary: 'Unmarked',
  marked_automation: 'Our tools',
  crawler_claimed: 'Crawler claim',
  agent_claimed: 'Agent claim',
  automation_claimed: 'Automation claim',
  health: 'Health check',
  scanner: 'Scanner',
  telemetry: 'Telemetry',
  unknown: 'Unknown',
};
const ms = (n: number | null) => (n === null ? '—' : duration(n));

export function OperationMetricsView({
  report,
  onRetry,
}: {
  report: OperationReport;
  onRetry?: () => void;
}) {
  if (report.status === 'off')
    return <p className="source-empty">Operation measurements are off.</p>;
  if (report.status === 'unavailable')
    return <Failure error="Operation measurements are unavailable." onRetry={onRetry} />;
  return (
    <>
      <p className="source-meta operation-metrics-note">
        {report.coverage.fullUntil
          ? `Full detail until ${new Date(report.coverage.fullUntil).toLocaleString()}.`
          : report.coverage.sampled
            ? `Normal detail: 1 in ${report.coverage.detailEvery}; failures and slow operations retained.`
            : 'Full detail capture.'}
      </p>
      {!report.rows.length ? (
        <p className="source-empty">No operations measured in this range.</p>
      ) : (
        <>
          <p className="source-meta operation-metrics-note">
            {report.coverage.truncated
              ? 'Showing the 500 busiest groups. Narrow the filters.'
              : 'Timings are measured at the server; browser reports are client reported.'}{' '}
            {report.rows.some((r) => r.estimated) && '≈ marks estimates from sampled data.'}
          </p>
          <div className="source-table-wrap">
            <table className="source-table admin-table">
              <thead>
                <tr>
                  {[
                    'Operation',
                    'Trigger',
                    'Traffic',
                    'Result',
                    'Count',
                    'P50',
                    'P95',
                    'P99',
                    'Queue P95',
                  ].map((h, i) => (
                    <th key={h} className={i >= 4 ? 'admin-num' : undefined}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr
                    key={[
                      r.component,
                      r.region,
                      r.authorityRegion,
                      r.revision,
                      r.kind,
                      r.operation,
                      r.source,
                      r.traffic,
                      r.actor,
                      r.outcome,
                    ].join('|')}
                  >
                    <td>
                      {r.operation}
                      <div className="source-meta">
                        {r.component} · {KIND[r.kind]} · {r.actor}
                        {r.region && ` · API ${r.region}`}{' '}
                        {r.authorityRegion && ` · Data ${r.authorityRegion}`}{' '}
                        {r.revision && ` · ${r.revision}`}
                      </div>
                    </td>
                    <td>{SOURCE[r.source]}</td>
                    <td>{TRAFFIC[r.traffic]}</td>
                    <td>{r.outcome}</td>
                    <td className="admin-num">{figure(r.requests, r.estimated)}</td>
                    <td className="admin-num">{ms(r.p50)}</td>
                    <td className="admin-num">{ms(r.p95)}</td>
                    <td className="admin-num">{ms(r.p99)}</td>
                    <td className="admin-num">{ms(r.queueWaitP95)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

export function AdminOperationMetrics() {
  const [range, setRange] = useState('24h');
  const [component, setComponent] = useState('');
  const [kind, setKind] = useState('');
  const [source, setSource] = useState('');
  const [traffic, setTraffic] = useState('');
  const query = new URLSearchParams({
    range,
    ...(component ? { component } : {}),
    ...(kind ? { kind } : {}),
    ...(source ? { source } : {}),
    ...(traffic ? { traffic } : {}),
  });
  const answer = useSource<OperationReport>(`/admin/operation-metrics?${query}`);
  useEffect(() => {
    if (!answer.loading) contentReady();
  }, [answer.loading]);
  const select = (
    label: string,
    value: string,
    change: (s: string) => void,
    options: Record<string, string>,
  ) => (
    <label>
      {label}{' '}
      <select value={value} onChange={(e) => change(e.target.value)}>
        {Object.entries(options).map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section className="home-section" aria-labelledby="operation-measurements">
      <div className="admin-traffic-row">
        <h2 className="home-label" id="operation-measurements">
          Operation measurements
        </h2>
        <div className="admin-filters operation-metrics-filters">
          {select('Service', component, setComponent, {
            '': 'All services',
            front: 'Website',
            platform: 'Platform',
            managed: 'Managed agents',
          })}
          {select('Range', range, setRange, {
            '1h': 'Last hour',
            '24h': '24 hours',
            '7d': '7 days',
            '30d': '30 days',
          })}
          {select('Work', kind, setKind, { '': 'All work', ...KIND })}
          {select('Trigger', source, setSource, { '': 'All triggers', ...SOURCE })}
          {select('Traffic', traffic, setTraffic, { '': 'All traffic', ...TRAFFIC })}
        </div>
      </div>
      {answer.loading && !answer.data ? (
        <Loading what="operation measurements" />
      ) : answer.error || !answer.data ? (
        <Failure what="operation measurements" error={answer.error ?? ''} onRetry={answer.reload} />
      ) : (
        <OperationMetricsView report={answer.data} onRetry={answer.reload} />
      )}
    </section>
  );
}
