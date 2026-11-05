// The Agents tab: what agent credentials did over the range. Credentials are the measure, since
// one can run many processes; the names of the clients behind them are the clients' own word.
import { useState } from 'react';
import {
  AGENT_CLIENTS,
  type AgentReport,
  type AgentResult,
} from '../../../../shared/platform-reports';
import { TRAFFIC_RANGES, type TrafficRange } from '../../../../shared/site-traffic';
import { EmptyState } from '../../components/EmptyState';
import { activityBars, percent } from '../source-platform/insightsModel';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useReadSource } from '../source-platform/useReadSource';
import { RangePicker } from './AdminParts';
import { TimeChart } from './TimeChart';
import { figure, RANGE_LABELS } from './trafficModel';

const clientName = (client: string) => AGENT_CLIENTS[client] ?? 'Not named';

function Clients({ r }: { r: AgentReport }) {
  return (
    <section className="home-section" aria-labelledby="admin-agent-clients">
      <h3 id="admin-agent-clients" className="home-label">
        Clients, self-reported
      </h3>
      <p className="source-meta">Each client names itself. We don't check it.</p>
      <div className="source-table-wrap">
        <table className="source-table admin-table">
          <thead>
            <tr>
              <th>Client</th>
              <th className="admin-num">Credentials</th>
              <th className="admin-num">Requests</th>
              <th className="admin-num">Landings</th>
            </tr>
          </thead>
          <tbody>
            {r.clients.map((c) => (
              <tr key={c.client}>
                <td>{clientName(c.client)}</td>
                <td className="admin-num">{figure(c.credentials, c.estimated)}</td>
                <td className="admin-num">{figure(c.requests, c.estimated)}</td>
                <td className="admin-num">{figure(c.landings, c.estimated)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Report({ r }: { r: AgentReport }) {
  const n = (value: number) => figure(value, r.estimated);
  const tiles = [
    { label: 'Active credentials', value: n(r.credentials), caption: 'Seen in this range' },
    { label: 'Sessions', value: n(r.sessions), caption: 'Half hours with activity' },
    { label: 'Peak concurrency', value: n(r.concurrency), caption: 'Credentials in one minute' },
    { label: 'Repositories reached', value: n(r.repositories), caption: 'That let an agent in' },
    { label: 'Organizations', value: n(r.organizations), caption: 'Owning those repositories' },
    { label: 'Reads', value: n(r.reads), caption: 'Clones and fetches too' },
    { label: 'Writes', value: n(r.writes), caption: 'Pushes too' },
    { label: 'MCP calls', value: n(r.mcp_calls), caption: 'Reads and writes, not split' },
    {
      label: 'Landings',
      value: n(r.landings),
      caption: `${n(r.landings_refused)} refused, ${n(r.landings_failed)} failed`,
    },
    { label: 'Success rate', value: percent(r.success_rate), caption: 'Of landings asked for' },
    { label: 'Retry rate', value: percent(r.retry_rate), caption: 'Repeats per landing asked for' },
    {
      label: 'Failures',
      value: n(r.failures),
      caption: `${n(r.unauthorized)} refused, ${n(r.rate_limited)} rate limited`,
    },
  ];
  const bars = r.series.map((b) => ({
    ...b,
    clones: b.credentials,
    pushes: 0,
    landings: 0,
    failed: 0,
  }));
  return (
    <>
      <h2 className="sr-only">Agents, last {RANGE_LABELS[r.range]}</h2>
      <ul className="stat-cards">
        {tiles.map((tile) => (
          <li key={tile.label} className="stat-card">
            <span className="stat-label">{tile.label}</span>
            <span className="stat-value">{tile.value}</span>
            {tile.caption && <span className="stat-caption">{tile.caption}</span>}
          </li>
        ))}
      </ul>
      <TimeChart
        id="admin-agents-chart"
        title="Active credentials"
        unit="credentials"
        bars={activityBars(bars, r.bucket)}
        summed={false}
      />
      <Clients r={r} />
    </>
  );
}

export function AdminAgents() {
  const [range, setRange] = useState<TrafficRange>('7d');
  const answer = useReadSource<AgentResult>(`/admin/agents?range=${range}`);
  const body = () => {
    if (answer.loading && !answer.data) return <Loading what="agents" />;
    if (answer.error || !answer.data)
      return <Failure error={answer.error ?? ''} what="agents" onRetry={answer.reload} />;
    if (!answer.data.ok)
      return answer.data.reason === 'query_failed' ? (
        <Failure error="The agents query failed. Try again in a minute." onRetry={answer.reload} />
      ) : (
        <p className="source-empty">This isn't set up here.</p>
      );
    if (answer.data.report.credentials === 0)
      return (
        <EmptyState title="No agents in this range">
          An agent shows up here after its first request.
        </EmptyState>
      );
    return <Report r={answer.data.report} />;
  };
  return (
    <>
      <div className="admin-traffic-row">
        <p className="source-meta">Counted by credential, not by process.</p>
        <RangePicker ranges={TRAFFIC_RANGES} range={range} onChange={setRange} />
      </div>
      {body()}
    </>
  );
}
