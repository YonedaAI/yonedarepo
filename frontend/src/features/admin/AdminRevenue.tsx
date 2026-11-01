// The revenue view on the overview, where ADMIN_BILLING is on: its range and its report.
import { type FormEvent, useState } from 'react';
import type { AdminRevenue } from '../../../../shared/admin-revenue';
import type { Navigate } from '../shell/useRoute';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useSource } from '../source-platform/useSource';
import { RevenueReport } from './AdminRevenueReport';
import { defaultRange, type RevenueRange, rangeProblem, revenuePath } from './adminRevenueModel';

function RangeForm({
  range,
  onRange,
}: {
  range: RevenueRange;
  onRange: (range: RevenueRange) => void;
}) {
  const [draft, setDraft] = useState(range);
  const problem = rangeProblem(draft);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!problem) onRange(draft);
  };
  return (
    <form className="admin-revenue-range" aria-label="Date range" onSubmit={submit}>
      <span className="admin-warn" role="status">
        {problem ?? ''}
      </span>
      <label>
        From
        <input
          type="date"
          value={draft.from}
          onChange={(event) => setDraft({ ...draft, from: event.target.value })}
        />
      </label>
      <label>
        To
        <input
          type="date"
          value={draft.to}
          onChange={(event) => setDraft({ ...draft, to: event.target.value })}
        />
      </label>
      <label>
        By
        <select
          value={draft.by}
          onChange={(event) => setDraft({ ...draft, by: event.target.value as RevenueRange['by'] })}
        >
          <option value="day">Day</option>
          <option value="month">Month</option>
        </select>
      </label>
      <button type="submit" className="quiet" disabled={problem !== null}>
        Show
      </button>
    </form>
  );
}

export function AdminRevenueSection({ navigate }: { navigate: Navigate }) {
  const [range, setRange] = useState(defaultRange);
  const loaded = useSource<AdminRevenue>(revenuePath(range));
  return (
    <section className="home-section admin-revenue" aria-labelledby="admin-revenue">
      <header className="admin-revenue-head">
        <h2 id="admin-revenue" className="home-label">
          Revenue
        </h2>
        <RangeForm range={range} onRange={setRange} />
      </header>
      {loaded.loading && !loaded.data && <Loading what="revenue" />}
      {loaded.error && <Failure error={loaded.error} what="revenue" onRetry={loaded.reload} />}
      {loaded.data && <RevenueReport report={loaded.data} navigate={navigate} />}
    </section>
  );
}
