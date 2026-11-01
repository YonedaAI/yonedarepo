// A repository's Insights: who has been using it over the range. The figures come from the page's
// one read (`GET /insights`), which the authority answers first, so what a viewer sees is what
// they may read. It keeps the last answer up while another range loads.
import { useState } from 'react';
import type {
  RepoInsights as Insights,
  InsightsCount,
  RepoContributor,
} from '../../../../shared/repo-insights';
import type { TrafficRange } from '../../../../shared/site-traffic';
import { EmptyState } from '../../components/EmptyState';
import { CountTable, RangePicker } from '../admin/AdminParts';
import { TimeChart } from '../admin/TimeChart';
import { figure } from '../admin/trafficModel';
import {
  activityBars,
  INSIGHT_RANGES,
  insightsEmpty,
  insightsPath,
  reasonLabel,
  whoLabel,
} from './insightsModel';
import { Person } from './Person';
import { Failure, Loading } from './SourceStatus';
import { useSource } from './useSource';

function Contributors({ rows, more }: { rows: RepoContributor[]; more: boolean }) {
  return (
    <section className="home-section" aria-labelledby="insights-contributors">
      <h3 id="insights-contributors" className="home-label">
        Contributors
      </h3>
      {rows.length ? (
        <div className="source-table-wrap">
          <table className="source-table admin-table">
            <thead>
              <tr>
                <th>Who</th>
                <th className="admin-num">Commits</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.principal}>
                  <td>
                    <Person principal={c.principal} />
                  </td>
                  <td className="admin-num">{figure(c.commits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="source-empty">No commits in this range.</p>
      )}
      {more && <p className="source-meta">Showing the 25 busiest.</p>}
    </section>
  );
}

function Report({ data, reload }: { data: Insights; reload: () => void }) {
  const { usage, contributors, more } = data;
  if (!usage)
    return (
      <>
        <Failure error="Couldn't load clones, pushes and landings." onRetry={reload} />
        <Contributors rows={contributors} more={more} />
      </>
    );
  const rough = usage.estimated;
  const tiles = [
    { label: 'Clones', value: usage.clones, caption: `${figure(usage.fetches, rough)} fetches` },
    { label: 'Pushes', value: usage.pushes },
    { label: 'Landings', value: usage.landings },
    { label: 'Failed landings', value: usage.failed_landings },
    { label: 'Contributors', value: contributors.length, exact: true },
  ];
  return (
    <>
      <ul className="stat-cards admin-tiles">
        {tiles.map((tile) => (
          <li key={tile.label} className="stat-card">
            <span className="stat-label">{tile.label}</span>
            <span className="stat-value">{figure(tile.value, rough && !tile.exact)}</span>
            {tile.caption && <span className="stat-caption">{tile.caption}</span>}
          </li>
        ))}
      </ul>
      <TimeChart
        id="insights-activity"
        title="Activity"
        unit="actions"
        bars={activityBars(usage.series, usage.bucket)}
      />
      <div className="admin-grid admin-grid-two">
        <CountTable
          id="insights-who"
          title="Who"
          label="Used by"
          rows={usage.who}
          name={whoLabel}
          none="Nobody in this range."
        />
        <CountTable
          id="insights-reasons"
          title="Why landings failed"
          label="Reason"
          rows={usage.reasons}
          name={reasonLabel}
          none="None failed in this range."
        />
      </div>
      <Contributors rows={contributors} more={more} />
      {rough && <p className="source-meta">≈ is an estimate: counts are sampled.</p>}
    </>
  );
}

export function RepoInsights({ repo }: { repo: string }) {
  const [range, setRange] = useState<TrafficRange>('30d');
  const insights = useSource<Insights>(insightsPath(repo, range));
  const { data, reload } = insights;
  return (
    <section aria-labelledby="insights-heading" className="insights" aria-busy={insights.loading}>
      <div className="source-changes-head">
        <h2 id="insights-heading">Insights</h2>
        <RangePicker ranges={INSIGHT_RANGES} range={range} onChange={setRange} />
      </div>
      {!data && !insights.error && <Loading what="insights" />}
      {insights.error && <Failure error={insights.error} what="insights" onRetry={reload} />}
      {data && insightsEmpty(data) && (
        <EmptyState title="Nothing in this range">
          Clones, pushes and landings show here as they happen.
        </EmptyState>
      )}
      {data && !insightsEmpty(data) && <Report data={data} reload={reload} />}
    </section>
  );
}
