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
import { AdminOperationMetrics } from './AdminOperationMetrics';
import { TIMING_HELP, TIMING_LABELS } from './adminOperationModel';
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

/** A table whose first column names a row and the rest are figures. */
function Figures({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="source-table-wrap">
      <table className="source-table admin-table">
        <thead>
          <tr>
            {head.map((name, i) => (
              <th key={name} className={i ? 'admin-num' : undefined} title={TIMING_HELP[name]}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, ...figures]) => (
            <tr key={name}>
              <td>{name}</td>
              {figures.map((value, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns never reorder.
                <td key={i} className="admin-num">
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Operations({ rows }: { rows: ServiceRow[] }) {
  if (!rows.some((r) => r.requests))
    return <p className="source-empty">No requests in the last 30 days.</p>;
  return (
    <Figures
      head={[
        'Operation',
        'Requests',
        'Failed',
        TIMING_LABELS.p50,
        TIMING_LABELS.p95,
        TIMING_LABELS.p99,
      ]}
      rows={rows.map((r) => [
        OPERATION[r.operation],
        figure(r.requests, r.estimated),
        failureShare(r.failure_rate),
        time(r.latency?.p50),
        time(r.latency?.p95),
        time(r.latency?.p99),
      ])}
    />
  );
}

function Outside({ rows }: { rows: ProbeRow[] }) {
  if (!rows.length) return null;
  return (
    <section className="home-section" aria-labelledby="admin-outside">
      <h2 id="admin-outside" className="home-label">
        From outside, last 30 days
      </h2>
      <Figures
        head={['Check', 'Runs', 'Failed', TIMING_LABELS.p50, TIMING_LABELS.p95]}
        rows={rows.map((r) => [
          CHECK[r.check] ?? 'Other check',
          figure(r.runs),
          figure(r.failed),
          time(r.latency?.p50),
          time(r.latency?.p95),
        ])}
      />
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

function LegacyServiceLevels() {
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

export function AdminServiceLevels() {
  return (
    <>
      <AdminOperationMetrics />
      <LegacyServiceLevels />
    </>
  );
}
