// The Visitors tab: browsers a day, visits and pages, then the way from a visit to a landing.
// A hash lasts a day, so the same person on two days counts twice, and the page says so.
import { useState } from 'react';
import type { FunnelStep, VisitorReport, VisitorResult } from '../../../../shared/platform-reports';
import { TRAFFIC_RANGES, type TrafficRange } from '../../../../shared/site-traffic';
import { activityBars, percent } from '../source-platform/insightsModel';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useReadSource } from '../source-platform/useReadSource';
import { CountTable, RangePicker } from './AdminParts';
import { countryName } from './adminModel';
import { TimeChart } from './TimeChart';
import { figure, RANGE_LABELS } from './trafficModel';

const STEPS: Record<FunnelStep['step'], string> = {
  visitors: 'Visitors',
  docs: 'Read the docs',
  signups: 'Signed up',
  repositories: 'Made a repository',
  pushed: 'First push',
  landed: 'First landing',
};
const DEVICES: Record<string, string> = { desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet' };

function Funnel({ steps }: { steps: FunnelStep[] }) {
  return (
    <section className="home-section" aria-labelledby="admin-funnel">
      <h3 id="admin-funnel" className="home-label">
        From a visit to a landing
      </h3>
      <div className="source-table-wrap">
        <table className="source-table admin-table">
          <thead>
            <tr>
              <th>Step</th>
              <th className="admin-num">Count</th>
              <th className="admin-num">Of the step before</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s, i) => {
              const before = steps[i - 1]?.count ?? 0;
              return (
                <tr key={s.step}>
                  <td>{STEPS[s.step]}</td>
                  <td className="admin-num">{figure(s.count, s.estimated)}</td>
                  <td className="admin-num">{percent(before ? s.count / before : null)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Report({ r }: { r: VisitorReport }) {
  const rough = r.estimated;
  const tiles = [
    ['Visitors', r.visitors],
    ['Sessions', r.sessions],
    ['Page views', r.views],
  ] as const;
  const bars = r.series.map((b) => ({
    ...b,
    clones: b.visitors,
    pushes: 0,
    landings: 0,
    failed: 0,
  }));
  const back = r.retention;
  return (
    <>
      <ul className="stat-cards admin-tiles-three">
        {tiles.map(([label, value]) => (
          <li key={label} className="stat-card">
            <span className="stat-label">{label}</span>
            <span className="stat-value">{figure(value, rough)}</span>
          </li>
        ))}
      </ul>
      <TimeChart
        id="admin-visitors-chart"
        title="Visitors"
        unit="visitors"
        bars={activityBars(bars, r.bucket)}
      />
      <Funnel steps={r.funnel} />
      <p className="source-meta">
        Active again a week later: {figure(back.returned)} of {figure(back.cohort)} accounts (
        {percent(back.cohort ? back.returned / back.cohort : null)}).
      </p>
      <div className="admin-grid">
        <CountTable id="admin-entries" title="Entry pages" label="Page" rows={r.entries} />
        <CountTable id="admin-exits" title="Exit pages" label="Page" rows={r.exits} />
        <CountTable id="admin-ref" title="Referrers" label="Site" rows={r.referrers} />
        <CountTable
          id="admin-where"
          title="Countries"
          label="Country"
          rows={r.countries}
          name={countryName}
        />
        <CountTable
          id="admin-devices"
          title="Devices"
          label="Device"
          rows={r.devices}
          name={(key) => DEVICES[key] ?? key}
        />
        <CountTable id="admin-browsers" title="Browsers" label="Browser" rows={r.browsers} />
      </div>
      <CountTable
        id="admin-sources"
        title="New accounts by source"
        label="Source"
        rows={r.campaigns.map((c) => ({
          key: `${c.key || 'Direct'}, ${figure(c.repositories)} made a repository`,
          count: c.signups,
          estimated: false,
        }))}
      />
    </>
  );
}

export function AdminVisitors() {
  const [range, setRange] = useState<TrafficRange>('30d');
  const answer = useReadSource<VisitorResult>(`/admin/visitors?range=${range}`);
  const body = () => {
    if (answer.loading && !answer.data) return <Loading what="visitors" />;
    if (answer.error || !answer.data)
      return <Failure error={answer.error ?? ''} what="visitors" onRetry={answer.reload} />;
    if (!answer.data.ok)
      return answer.data.reason === 'query_failed' ? (
        <Failure
          error="The visitors query failed. Try again in a minute."
          onRetry={answer.reload}
        />
      ) : (
        <p className="source-empty">This isn't set up here.</p>
      );
    const r = answer.data.report;
    const nothing = r.visitors === 0 && r.funnel.every((s) => s.count === 0);
    return nothing ? <p className="source-empty">No visitors in this range.</p> : <Report r={r} />;
  };
  return (
    <>
      <div className="admin-traffic-row">
        <p className="source-meta">
          Counted a day at a time: someone back the next day counts again.
        </p>
        <RangePicker ranges={TRAFFIC_RANGES} range={range} onChange={setRange} />
      </div>
      <h2 className="sr-only">Visitors, last {RANGE_LABELS[range]}</h2>
      {body()}
    </>
  );
}
