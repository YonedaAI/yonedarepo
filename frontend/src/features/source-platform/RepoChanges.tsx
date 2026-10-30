// The Changes tab: change requests (branches proposed for landing on a base branch, main by
// default), filtered by status.
import { useState } from 'react';
import { CHANGE_FILTERS, type Change, type ChangeFilter, changesPath } from './changeModel';
import { usePeople } from './people';
import { Failure, Loading } from './SourceStatus';
import { when } from './sourceApi';
import { type Loaded, useSource } from './useSource';

export function ChangeStatusChip({ status }: { status: Change['status'] }) {
  return <span className={`source-change-status source-change-${status}`}>{status}</span>;
}

const EMPTY: Record<ChangeFilter, string> = {
  open: 'No open changes. Push a branch and open a change to propose landing it.',
  landed: 'No landed changes yet.',
  closed: 'No closed changes.',
  all: 'No changes yet. Push a branch and open a change to propose landing it.',
};

export function ChangeTable({
  changes,
  filter,
  hrefOf,
  onOpen,
}: {
  changes: Loaded<{ changes: Change[] }>;
  filter: ChangeFilter;
  hrefOf: (n: number) => string;
  onOpen: (n: number) => void;
}) {
  const people = usePeople();
  if (changes.loading && !changes.data) return <Loading what="changes" />;
  if (changes.error) return <Failure error={changes.error} onRetry={changes.reload} />;
  const rows = changes.data?.changes ?? [];
  if (rows.length === 0) return <p className="source-empty">{EMPTY[filter]}</p>;
  return (
    <ul className="source-changes" aria-label={`${filter} changes`} aria-busy={changes.loading}>
      {rows.map((c) => (
        <li key={c.number}>
          <ChangeStatusChip status={c.status} />
          <a
            href={hrefOf(c.number)}
            onClick={(e) => {
              e.preventDefault();
              onOpen(c.number);
            }}
          >
            <strong>{c.title}</strong> <span className="source-meta">#{c.number}</span>
          </a>
          <span className="source-meta">
            <code>{c.branch}</code> → {c.base} · {people.principal(c.author)} ·{' '}
            {c.status === 'landed' && c.landed_version !== null
              ? `landed v${c.landed_version} · `
              : ''}
            updated {when(c.updated_at)}
            {c.comment_count > 0 &&
              ` · ${c.comment_count} comment${c.comment_count === 1 ? '' : 's'}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function StatusFilter({
  value,
  onChange,
}: {
  value: ChangeFilter;
  onChange: (f: ChangeFilter) => void;
}) {
  return (
    <fieldset className="segmented">
      <legend className="sr-only">Status</legend>
      {CHANGE_FILTERS.map((f) => (
        <button key={f} type="button" aria-pressed={value === f} onClick={() => onChange(f)}>
          {f[0].toUpperCase() + f.slice(1)}
        </button>
      ))}
    </fieldset>
  );
}

export function RepoChanges({
  repo,
  onOpen,
  hrefOf = () => '#',
  initialFilter = 'open',
}: {
  repo: string;
  onOpen: (n: number) => void;
  hrefOf?: (n: number) => string;
  initialFilter?: ChangeFilter;
}) {
  const [filter, setFilter] = useState<ChangeFilter>(initialFilter);
  const changes = useSource<{ changes: Change[] }>(changesPath(repo, filter));
  return (
    <section aria-labelledby="changes-heading">
      <div className="source-changes-head">
        <h2 id="changes-heading">Changes</h2>
        <StatusFilter value={filter} onChange={setFilter} />
      </div>
      <ChangeTable changes={changes} filter={filter} hrefOf={hrefOf} onOpen={onOpen} />
    </section>
  );
}
