// The Traffic page's landings across repositories, over the page's range: how many landed, how
// long they took, what stopped the rest, and direct pushes apart. A failed read stays in this
// section: the page's traffic still stands.
import type { LandingReportResult } from '../../../../shared/repo-insights';
import type { TrafficRange } from '../../../../shared/site-traffic';
import { duration, percent, reasonLabel } from '../source-platform/insightsModel';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useSource } from '../source-platform/useSource';
import { figure, RANGE_LABELS } from './trafficModel';

export function AdminLandings({ range }: { range: TrafficRange }) {
  const answer = useSource<LandingReportResult>(`/admin/traffic/landings?range=${range}`);
  const heading = (
    <h2 id="admin-landings" className="home-label">
      Landings, last {RANGE_LABELS[range]}
    </h2>
  );
  const body = () => {
    if (answer.loading && !answer.data) return <Loading what="landings" />;
    if (answer.error || !answer.data)
      return <Failure error={answer.error ?? ''} what="landings" onRetry={answer.reload} />;
    if (!answer.data.ok)
      return answer.data.reason === 'query_failed' ? (
        <Failure
          error="The landings query failed. Try again in a minute."
          onRetry={answer.reload}
        />
      ) : (
        <p className="source-empty">Landings aren't counted here.</p>
      );
    const r = answer.data.report;
    const rough = r.estimated;
    const n = (value: number) => figure(value, rough);
    if (r.landed + r.refused + r.failed + r.checks.run + r.direct_pushes.total === 0)
      return <p className="source-empty">No landings in this range.</p>;
    const tiles = [
      {
        label: 'Success rate',
        value: percent(r.success_rate),
        caption: `${n(r.landed)} landed, ${n(r.refused)} refused, ${n(r.failed)} failed`,
      },
      {
        label: 'Time to land',
        value: r.latency ? duration(r.latency.p50) : '—',
        caption: r.latency
          ? `P95 ${duration(r.latency.p95)}, P99 ${duration(r.latency.p99)}`
          : 'P50, once something lands',
      },
      {
        label: 'Queue wait',
        value: r.queue ? duration(r.queue.p50) : '—',
        caption: r.queue ? `P95 ${duration(r.queue.p95)}` : 'P50, once something lands',
      },
      { label: 'Retries', value: n(r.retries), caption: 'Rounds repeated, or asked again' },
      {
        label: 'Checks run',
        value: n(r.checks.run),
        caption: `${n(r.checks.failed)} failed`,
      },
      {
        label: 'Direct pushes',
        value: n(r.direct_pushes.total),
        caption: `${n(r.direct_pushes.refused)} refused, not in the rate`,
      },
    ];
    return (
      <>
        <ul className="stat-cards admin-tiles-three">
          {tiles.map((tile) => (
            <li key={tile.label} className="stat-card">
              <span className="stat-label">{tile.label}</span>
              <span className="stat-value">{tile.value}</span>
              <span className="stat-caption">{tile.caption}</span>
            </li>
          ))}
        </ul>
        {r.reasons.length > 0 && (
          <div className="source-table-wrap">
            <table className="source-table admin-table">
              <caption className="sr-only">Why landings failed</caption>
              <thead>
                <tr>
                  <th>Why landings failed</th>
                  <th className="admin-num">Landings</th>
                </tr>
              </thead>
              <tbody>
                {r.reasons.map((reason) => (
                  <tr key={reason.key}>
                    <td>{reasonLabel(reason.key)}</td>
                    <td className="admin-num">{figure(reason.count, reason.estimated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  };
  return (
    <section className="home-section" aria-labelledby="admin-landings">
      {heading}
      {body()}
    </section>
  );
}
