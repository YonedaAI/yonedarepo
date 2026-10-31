// The revenue view on the overview, where ADMIN_BILLING is on: its range, its report and the
// rebuild from the ledgers.
import { type FormEvent, useState } from 'react';
import type { AdminRevenue } from '../../../../shared/admin-billing';
import { Dialog } from '../../components/Dialog';
import type { Navigate } from '../shell/useRoute';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { sourceApi } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import { RevenueReport } from './AdminRevenueReport';
import {
  defaultRange,
  type RebuildPage,
  type RevenueRange,
  rangeProblem,
  rebuildAll,
  revenuePath,
} from './adminRevenueModel';

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
      <span className="admin-warn" role="status">
        {problem ?? ''}
      </span>
    </form>
  );
}

function Rebuild({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  async function run() {
    setBusy(true);
    setError('');
    try {
      const total = await rebuildAll((after) =>
        sourceApi<RebuildPage>('/admin/revenue/rebuild', { method: 'POST', body: { after } }),
      );
      setOpen(false);
      setDone(`Asked ${total} accounts to push again. Figures catch up over the next minutes.`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="admin-actions">
      <button type="button" className="quiet" onClick={() => setOpen(true)}>
        Rebuild from the ledgers
      </button>
      {done && (
        <p role="status" className="admin-done">
          {done}
        </p>
      )}
      {open && (
        <Dialog title="Rebuild from the ledgers" onClose={() => setOpen(false)} locked={busy}>
          <p>
            Every account's ledger pushes all its days again. No money moves and the figures only
            get more complete, but it wakes every account, so it is for the first use and repairs.
          </p>
          {error && <Failure error={error} />}
          <div className="admin-dialog-actions">
            <button type="button" className="quiet" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" disabled={busy} onClick={run}>
              {busy ? 'Working…' : 'Rebuild'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export function AdminRevenueSection({ navigate }: { navigate: Navigate }) {
  const [range, setRange] = useState(defaultRange);
  const loaded = useSource<AdminRevenue>(revenuePath(range));
  return (
    <section className="home-section admin-revenue" aria-labelledby="admin-revenue">
      <h2 id="admin-revenue" className="home-label">
        Revenue
      </h2>
      <RangeForm range={range} onRange={setRange} />
      {loaded.loading && !loaded.data && <Loading what="revenue" />}
      {loaded.error && <Failure error={loaded.error} what="revenue" onRetry={loaded.reload} />}
      {loaded.data && <RevenueReport report={loaded.data} navigate={navigate} />}
      <Rebuild onDone={loaded.reload} />
    </section>
  );
}
