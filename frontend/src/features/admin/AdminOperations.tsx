// The Operations tab (how each operation went, by client) and the Infrastructure tab (queues,
// Workers, the database and storage, as Cloudflare reports them, a few minutes behind).
import { useState } from 'react';
import type {
  InfrastructureResult,
  OperationRow,
  OperationsResult,
  Section,
} from '../../../../shared/platform-reports';
import { TRAFFIC_RANGES, type TrafficRange } from '../../../../shared/site-traffic';
import { byteSize, duration } from '../source-platform/insightsModel';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useReadSource } from '../source-platform/useReadSource';
import { useSource } from '../source-platform/useSource';
import { RangePicker } from './AdminParts';
import { CLIENTS } from './AdminTrafficCheck';
import { figure, RANGE_LABELS } from './trafficModel';

const OPERATIONS: Record<string, string> = {
  clone: 'Clone or fetch',
  push: 'Push',
  land: 'Landing',
  mcp: 'MCP call',
  read: 'Read',
  write: 'Write',
};
const clientName = (client: string) =>
  client === 'browser' ? 'Browser' : (CLIENTS[client] ?? client);
const NOT_HERE = "This isn't set up here.";

function OperationsTable({ rows }: { rows: OperationRow[] }) {
  return (
    <div className="source-table-wrap">
      <table className="source-table admin-table">
        <caption className="sr-only">Outcomes and time to answer, busiest first</caption>
        <thead>
          <tr>
            <th>Operation</th>
            <th>Client</th>
            <th className="admin-num">Requests</th>
            <th className="admin-num">Failed</th>
            <th className="admin-num">Refused</th>
            <th className="admin-num">Rate limited</th>
            <th className="admin-num">P50</th>
            <th className="admin-num">P95</th>
            <th className="admin-num">P99</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.operation}:${r.client}`}>
              <td>{OPERATIONS[r.operation] ?? r.operation}</td>
              <td>{clientName(r.client)}</td>
              <td className="admin-num">{figure(r.count, r.estimated)}</td>
              <td className="admin-num">{figure(r.failed, r.estimated)}</td>
              <td className="admin-num">{figure(r.unauthorized, r.estimated)}</td>
              <td className="admin-num">{figure(r.rate_limited, r.estimated)}</td>
              <td className="admin-num">{duration(r.p50)}</td>
              <td className="admin-num">{duration(r.p95)}</td>
              <td className="admin-num">{duration(r.p99)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminOperations() {
  const [range, setRange] = useState<TrafficRange>('7d');
  const answer = useReadSource<OperationsResult>(`/admin/operations?range=${range}`);
  const body = () => {
    if (answer.loading && !answer.data) return <Loading what="operations" />;
    if (answer.error || !answer.data)
      return <Failure error={answer.error ?? ''} what="operations" onRetry={answer.reload} />;
    if (!answer.data.ok)
      return answer.data.reason === 'query_failed' ? (
        <Failure
          error="The operations query failed. Try again in a minute."
          onRetry={answer.reload}
        />
      ) : (
        <p className="source-empty">{NOT_HERE}</p>
      );
    if (!answer.data.rows.length) return <p className="source-empty">No requests in this range.</p>;
    return <OperationsTable rows={answer.data.rows} />;
  };
  return (
    <>
      <div className="admin-traffic-row">
        <h2 className="home-label">Operations, last {RANGE_LABELS[range]}</h2>
        <RangePicker ranges={TRAFFIC_RANGES} range={range} onChange={setRange} />
      </div>
      {body()}
    </>
  );
}

function Part<T>({
  id,
  title,
  section,
  children,
}: {
  id: string;
  title: string;
  section: Section<T>;
  children: (value: T) => React.ReactNode;
}) {
  return (
    <section className="home-section" aria-labelledby={id}>
      <h2 id={id} className="home-label">
        {title}
      </h2>
      {section.ok ? children(section.value) : <p className="source-empty">Couldn't read this.</p>}
    </section>
  );
}

const clock = (iso: string) => `${iso.slice(11, 16)} UTC`;

export function AdminInfrastructure() {
  const answer = useSource<InfrastructureResult>('/admin/infrastructure');
  if (answer.loading && !answer.data) return <Loading what="infrastructure" />;
  if (answer.error || !answer.data)
    return <Failure error={answer.error ?? ''} what="infrastructure" onRetry={answer.reload} />;
  if (!answer.data.ok) return <p className="source-empty">{NOT_HERE}</p>;
  const r = answer.data.report;
  return (
    <>
      <p className="source-meta">
        These figures are minutes old. Queues and Workers cover {clock(r.start)} to {clock(r.end)}.
      </p>
      <Part id="admin-queues" title="Queues" section={r.queues}>
        {(queues) => (
          <div className="source-table-wrap">
            <table className="source-table admin-table">
              <thead>
                <tr>
                  <th>Queue</th>
                  <th className="admin-num">Waiting</th>
                  <th className="admin-num">Longest wait</th>
                  <th className="admin-num">Retries</th>
                  <th className="admin-num">Dead letters</th>
                </tr>
              </thead>
              <tbody>
                {queues.map((q) => (
                  <tr key={q.label}>
                    <td>{q.label}</td>
                    <td className="admin-num">{figure(q.backlog)}</td>
                    <td className="admin-num">{duration(q.wait_ms)}</td>
                    <td className="admin-num">{figure(q.retries)}</td>
                    <td className="admin-num">
                      {figure(q.dead_letter_queue ? q.backlog : q.dead_lettered)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Part>
      <Part id="admin-workers" title="Workers" section={r.workers}>
        {(workers) =>
          workers.length ? (
            <div className="source-table-wrap">
              <table className="source-table admin-table">
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th className="admin-num">Requests</th>
                    <th className="admin-num">Errors</th>
                    <th className="admin-num">CPU P50</th>
                    <th className="admin-num">CPU P99</th>
                  </tr>
                </thead>
                <tbody>
                  {workers.map((w) => (
                    <tr key={w.script}>
                      <td>{w.script}</td>
                      <td className="admin-num">{figure(w.requests)}</td>
                      <td className="admin-num">{figure(w.errors)}</td>
                      <td className="admin-num">{duration(w.cpu_p50)}</td>
                      <td className="admin-num">{duration(w.cpu_p99)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="source-empty">No requests in this hour.</p>
          )
        }
      </Part>
      <div className="admin-grid admin-grid-two">
        <Part id="admin-database" title="Database" section={r.database}>
          {(d) => (
            <p>
              {duration(d.latency_p50)} P50, {duration(d.latency_p90)} P90. {byteSize(d.bytes)}{' '}
              held.
            </p>
          )}
        </Part>
        <Part id="admin-storage" title="Object storage" section={r.storage}>
          {(s) => (
            <p>
              {byteSize(s.bytes)} in {figure(s.objects)} objects. {s.change_7d < 0 ? '−' : '+'}
              {byteSize(Math.abs(s.change_7d))} in 7 days.
            </p>
          )}
        </Part>
      </div>
    </>
  );
}
