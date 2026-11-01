// The Repositories tab's most active and fastest growing, over a range. Off here, it shows nothing.
// Fastest growing is by bytes pushed: nothing keeps a repository's past sizes.
import { useState } from 'react';
import type { RepoUsageResult, RepoUsageRow } from '../../../../shared/repo-insights';
import type { TrafficRange } from '../../../../shared/site-traffic';
import { linkTo, type Navigate } from '../shell/useRoute';
import { byteSize } from '../source-platform/insightsModel';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useSource } from '../source-platform/useSource';
import { RangePicker } from './AdminParts';
import { figure, RANGE_LABELS } from './trafficModel';

const RANGES: TrafficRange[] = ['7d', '30d', '90d'];

function Table({
  id,
  title,
  rows,
  head,
  value,
  navigate,
}: {
  id: string;
  title: string;
  rows: RepoUsageRow[];
  head: string;
  value: (row: RepoUsageRow) => string;
  navigate: Navigate;
}) {
  return (
    <section className="home-section" aria-labelledby={id}>
      <h2 id={id} className="home-label">
        {title}
      </h2>
      {rows.length ? (
        <div className="source-table-wrap">
          <table className="source-table admin-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th className="admin-num">{head}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="admin-key">
                    <a {...linkTo({ view: 'files', repo: r.id, path: '', ref: 'main' }, navigate)}>
                      {r.handle ? `${r.handle}/${r.name}` : r.name}
                    </a>
                  </td>
                  <td className="admin-num">{value(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="source-empty">None in this range.</p>
      )}
    </section>
  );
}

export function RepoUsage({ navigate }: { navigate: Navigate }) {
  const [range, setRange] = useState<TrafficRange>('30d');
  const answer = useSource<RepoUsageResult>(`/admin/repos/usage?range=${range}`);
  if (answer.data && !answer.data.ok && answer.data.reason !== 'query_failed') return null;
  const body = () => {
    if (answer.loading && !answer.data) return <Loading what="repository use" />;
    if (answer.error || !answer.data)
      return <Failure error={answer.error ?? ''} what="repository use" onRetry={answer.reload} />;
    if (!answer.data.ok)
      return (
        <Failure
          error="The repository use query failed. Try again in a minute."
          onRetry={answer.reload}
        />
      );
    const { most_active, fastest_growing } = answer.data.report;
    return (
      <div className="admin-grid admin-grid-two">
        <Table
          id="admin-most-active"
          title="Most active"
          head="Actions"
          rows={most_active}
          value={(r) => figure(r.actions, r.estimated)}
          navigate={navigate}
        />
        <Table
          id="admin-fastest-growing"
          title="Fastest growing, by bytes pushed"
          head="Pushed"
          rows={fastest_growing}
          value={(r) => `${r.estimated ? '≈' : ''}${byteSize(r.pushed_bytes)}`}
          navigate={navigate}
        />
      </div>
    );
  };
  return (
    <>
      <div className="admin-traffic-row">
        <h2 className="home-label">Use, last {RANGE_LABELS[range]}</h2>
        <RangePicker ranges={RANGES} range={range} onChange={setRange} />
      </div>
      {body()}
    </>
  );
}
