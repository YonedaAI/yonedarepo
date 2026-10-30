// Pieces the admin pages share: a paged listing (the first page read like any page, later
// ones appended by "Load more"), its search box and its button.
import { Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { sourceApi } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import type { Page } from './adminModel';

/** The listing `pathOf(before)` pages through, newest first. */
export function usePaged<T>(pathOf: (before?: number) => string) {
  const first = useSource<Page<T>>(pathOf());
  const [later, setLater] = useState<Page<T>[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pages = first.data ? [first.data, ...later] : [];
  const next = pages.at(-1)?.next ?? null;
  async function more() {
    if (next === null) return;
    setBusy(true);
    setError('');
    try {
      const page = await sourceApi<Page<T>>(pathOf(next));
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
export function PagedStatus({
  paged,
  what,
  empty,
}: {
  paged: ReturnType<typeof usePaged<unknown>>;
  what: string;
  empty: string;
}) {
  return (
    <>
      {paged.first.loading && !paged.first.data && <Loading what={what} />}
      {paged.first.error && (
        <Failure error={paged.first.error} what={what} onRetry={paged.reload} />
      )}
      {paged.first.data && paged.items.length === 0 && <p className="source-empty">{empty}</p>}
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
