import { useEffect, useState } from 'react';
import type { OperationReport } from '../../../../shared/operation-metrics';
import { contentReady } from '../site/clientPerformance';
import { duration } from '../source-platform/insightsModel';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useSource } from '../source-platform/useSource';
import {
  OPERATION_KIND as KIND,
  nextOperationSort,
  OPERATION_COLUMNS,
  type OperationSort,
  OPERATION_SOURCE as SOURCE,
  sortOperationRows,
  TIMING_HELP,
  OPERATION_TRAFFIC as TRAFFIC,
} from './adminOperationModel';
import { figure } from './trafficModel';

const ms = (n: number | null) => (n === null ? '—' : duration(n));

export function OperationMetricsView({
  report,
  onRetry,
}: {
  report: OperationReport;
  onRetry?: () => void;
}) {
  const [order, setOrder] = useState<OperationSort>({ key: 'requests', direction: 'desc' });
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
          <section
            className="source-table-wrap"
            aria-label="Measured operations"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll the wide table.
            tabIndex={0}
          >
            <table className="source-table admin-table">
              <thead>
                <tr>
                  {OPERATION_COLUMNS.map(({ key, label, number }) => (
                    <th
                      key={key}
                      className={number ? 'admin-num' : undefined}
                      aria-sort={
                        order.key === key
                          ? order.direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      <button
                        type="button"
                        className="admin-sort"
                        title={TIMING_HELP[label]}
                        aria-label={`Sort by ${label.toLowerCase()}`}
                        onClick={() => setOrder((current) => nextOperationSort(current, key))}
                      >
                        {label}
                        <span aria-hidden="true">
                          {order.key === key ? (order.direction === 'asc' ? ' ↑' : ' ↓') : ' ↕'}
                        </span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortOperationRows(report.rows, order).map((r) => (
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
          </section>
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
      <div className="operation-metrics-header">
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
