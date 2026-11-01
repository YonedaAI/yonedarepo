// The Infrastructure tab's service levels: how the operations with service targets are doing, and
// what the synthetic checks see from outside. It shows values only: no target exists until 30 days
// of data do (docs/observability-plan.md). It reads its own route and has no part in the tab's other
// sections, so one that fails leaves the others up.
import { useState } from 'react';
import {
  MEASURING_DAYS,
  type ProbeRow,
  type ServiceLevels,
  type ServiceLevelsResult,
  type ServiceOperation,
  type ServiceRow,
} from '../../../../shared/service-levels';
import { duration } from '../source-platform/insightsModel';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useSource } from '../source-platform/useSource';
import { figure } from './trafficModel';

type Who = 'people' | 'ours';
const WHO: { id: Who; label: string }[] = [
  { id: 'people', label: 'Everyone else' },
  { id: 'ours', label: 'Our tools' },
];
const OPERATION: Record<ServiceOperation, string> = {
  api_read: 'API reads',
  landing: 'Landings',
  git_clone: 'Git clone, until the pack starts',
  git_push: 'Git push',
  repo_create: 'Repository create',
};
const CHECK: Record<string, string> = {
  health: 'Website health',
  page: 'Home page',
  api: 'API read',
  clone: 'Whole clone of a small repository',
  land: 'Test landing',
};
const DASH = '—';

/** A failure rate: small ones are the ones that matter, so they keep their digits. */
export function failureShare(share: number | null) {
  if (share === null) return DASH;
  const percent = share * 100;
  return `${percent > 0 && percent < 10 ? percent.toFixed(2) : Math.round(percent)}%`;
}

const time = (ms: number | undefined) => (ms === undefined ? DASH : duration(ms));

/** Where the 30 days stand. Past them, someone can set a target. */
export const measuredLine = (days: number) =>
  days >= MEASURING_DAYS
    ? `${MEASURING_DAYS} days of data. No targets are set yet.`
    : `Day ${days} of ${MEASURING_DAYS}. Targets follow ${MEASURING_DAYS} days of data.`;

function Operations({ rows }: { rows: ServiceRow[] }) {
  if (!rows.some((r) => r.requests))
    return <p className="source-empty">No requests in the last 30 days.</p>;
  return (
    <div className="source-table-wrap">
      <table className="source-table admin-table">
        <thead>
          <tr>
            <th>Operation</th>
            <th className="admin-num">Requests</th>
            <th className="admin-num">Failed</th>
            <th className="admin-num">P50</th>
            <th className="admin-num">P95</th>
            <th className="admin-num">P99</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.operation}>
              <td>{OPERATION[r.operation]}</td>
              <td className="admin-num">{figure(r.requests, r.estimated)}</td>
              <td className="admin-num">{failureShare(r.failure_rate)}</td>
              <td className="admin-num">{time(r.latency?.p50)}</td>
              <td className="admin-num">{time(r.latency?.p95)}</td>
              <td className="admin-num">{time(r.latency?.p99)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Outside({ rows }: { rows: ProbeRow[] }) {
  if (!rows.length) return null;
  return (
    <section className="home-section" aria-labelledby="admin-outside">
      <h2 id="admin-outside" className="home-label">
        From outside, last 30 days
      </h2>
      <div className="source-table-wrap">
        <table className="source-table admin-table">
          <thead>
            <tr>
              <th>Check</th>
              <th className="admin-num">Runs</th>
              <th className="admin-num">Failed</th>
              <th className="admin-num">P50</th>
              <th className="admin-num">P95</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.check}>
                <td>{CHECK[r.check] ?? 'Other check'}</td>
                <td className="admin-num">{figure(r.runs)}</td>
                <td className="admin-num">{figure(r.failed)}</td>
                <td className="admin-num">{time(r.latency?.p50)}</td>
                <td className="admin-num">{time(r.latency?.p95)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** One report, for one audience. */
export function ServiceLevelsView({
  report,
  who,
  onWho,
}: {
  report: ServiceLevels;
  who: Who;
  onWho: (who: Who) => void;
}) {
  return (
    <>
      <section className="home-section" aria-labelledby="admin-service-levels">
        <div className="admin-traffic-row">
          <h2 id="admin-service-levels" className="home-label">
            Service levels, last 30 days
          </h2>
          <fieldset className="admin-window">
            <legend className="sr-only">Whose requests</legend>
            {WHO.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className="quiet"
                aria-pressed={who === id}
                onClick={() => onWho(id)}
              >
                {label}
              </button>
            ))}
          </fieldset>
        </div>
        {report.days_measured > 0 && (
          <p className="source-meta">{measuredLine(report.days_measured)}</p>
        )}
        <Operations rows={report[who]} />
      </section>
      <Outside rows={report.outside} />
    </>
  );
}

export function AdminServiceLevels() {
  const answer = useSource<ServiceLevelsResult>('/admin/service-levels');
  const [who, setWho] = useState<Who>('people');
  if (answer.loading && !answer.data) return <Loading what="service levels" />;
  if (answer.error || !answer.data)
    return <Failure error={answer.error ?? ''} what="service levels" onRetry={answer.reload} />;
  if (!answer.data.ok)
    return answer.data.reason === 'query_failed' ? (
      <Failure
        error="The service levels query failed. Try again in a minute."
        onRetry={answer.reload}
      />
    ) : (
      <p className="source-empty">Service levels aren't measured here.</p>
    );
  return <ServiceLevelsView report={answer.data.report} who={who} onWho={setWho} />;
}
