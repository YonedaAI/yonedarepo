// Pieces the admin pages share: a paged listing (the first page read like any page, later
// ones appended by "Load more"), its search box and its button.
import { Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { TrafficRange } from '../../../../shared/site-traffic';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { sourceApi } from '../source-platform/sourceApi';
import { useReadSource } from '../source-platform/useReadSource';
import type { Page } from './adminModel';
import { figure, RANGE_LABELS } from './trafficModel';

/** The server listing `pathOf(cursor)` pages through, in its requested order. */
export function usePaged<T, Cursor = number>(pathOf: (before?: Cursor) => string) {
  const first = useReadSource<Page<T, Cursor>>(pathOf());
  const [later, setLater] = useState<Page<T, Cursor>[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pages = first.data ? [first.data, ...later] : [];
  const next = pages.at(-1)?.next ?? null;
  async function more() {
    if (next === null) return;
    setBusy(true);
    setError('');
    try {
      const page = await sourceApi<Page<T, Cursor>>(pathOf(next));
      setLater((loaded) => [...loaded, page]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return {
    items: pages.flatMap((p) => p.items),
    first,
    next,
    busy,
    error,
    more,
    reload: () => {
      setLater([]);
      first.reload();
    },
  };
}

/** Loading, failure, empty text and "Load more" around a paged table. */
export function PagedStatus<Cursor = number>({
  paged,
  what,
  empty,
}: {
  paged: ReturnType<typeof usePaged<unknown, Cursor>>;
  what: string;
  empty: string;
}) {
  return (
    <>
      {paged.first.loading && !paged.first.data && <Loading what={what} />}
      {paged.first.error && (
        <Failure error={paged.first.error} what={what} onRetry={paged.reload} />
      )}
      {paged.first.data && paged.items.length === 0 && empty && (
        <p className="source-empty">{empty}</p>
      )}
      {paged.error && <Failure error={paged.error} what={what} onRetry={paged.more} />}
      {paged.next !== null && (
        <button
          type="button"
          className="quiet admin-more"
          disabled={paged.busy}
          onClick={paged.more}
        >
          {paged.busy ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  );
}

/** A search form: the term applies on submit (Enter), not on every key. */
export function SearchBox({
  label,
  value,
  onSearch,
}: {
  label: string;
  value: string;
  onSearch: (q: string) => void;
}) {
  const [text, setText] = useState(value);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(text.trim());
  };
  return (
    <form className="admin-search" aria-label={label} onSubmit={submit}>
      <label>
        <span className="sr-only">{label}</span>
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          value={text}
          placeholder={label}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <button type="submit" className="quiet">
        Search
      </button>
    </form>
  );
}

/** The range buttons of a report's header row. */
export function RangePicker({
  ranges,
  range,
  onChange,
}: {
  ranges: TrafficRange[];
  range: TrafficRange;
  onChange: (range: TrafficRange) => void;
}) {
  return (
    <fieldset className="admin-window">
      <legend className="sr-only">Range</legend>
      {ranges.map((id) => (
        <button
          key={id}
          type="button"
          className="quiet"
          aria-pressed={range === id}
          onClick={() => onChange(id)}
        >
          {RANGE_LABELS[id]}
        </button>
      ))}
    </fieldset>
  );
}

/** A titled list of counts, or one line when it has none. */
export function CountTable({
  id,
  title,
  label,
  rows,
  name = (key) => key,
  none = 'None in this range.',
}: {
  id: string;
  title: string;
  /** The key column's heading. */
  label: string;
  rows: { key: string; count: number; estimated: boolean }[];
  name?: (key: string) => string;
  none?: string;
}) {
  return (
    <section className="home-section" aria-labelledby={id}>
      <h3 id={id} className="home-label">
        {title}
      </h3>
      {rows.length ? (
        <div className="source-table-wrap">
          <table className="source-table admin-table">
            <thead>
              <tr>
                <th>{label}</th>
                <th className="admin-num">Count</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="admin-key">{name(r.key)}</td>
                  <td className="admin-num">{figure(r.count, r.estimated)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="source-empty">{none}</p>
      )}
    </section>
  );
}
