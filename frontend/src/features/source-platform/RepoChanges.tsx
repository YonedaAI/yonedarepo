// The Landings tab: change requests (branches proposed for landing on a base branch, main by
// default), filtered by status, with the landings no change names.
import { useState } from 'react';
import {
  CHANGE_FILTERS,
  type Change,
  type ChangeFilter,
  type ChangeList,
  changesPath,
  type DirectLanding,
  type LandingState,
  landingRows,
  landingState,
} from './changeModel';
import { Person } from './Person';
import { Failure, Loading } from './SourceStatus';
import { shortSha, when } from './sourceApi';
import { type Loaded, useSource } from './useSource';

export function ChangeStatusChip({
  status,
  state,
}: {
  status: Change['status'];
  state: LandingState;
}) {
  return <span className={`source-change-status source-change-${status}`}>{state}</span>;
}

const EMPTY: Record<ChangeFilter, string> = {
  open: 'No open Landings. Push a branch and open a change to propose landing it.',
  landed: 'No landed Landings yet.',
  closed: 'No closed Landings.',
  all: 'No Landings yet. Push a branch and open a change to propose landing it.',
};

function DirectRow({
  landing,
  href,
  onOpen,
}: {
  landing: DirectLanding;
  href: string;
  onOpen?: (commit: string) => void;
}) {
  return (
    <>
      <span className="source-change-status source-change-landed">Landed directly</span>
      <a
        href={href}
        onClick={(e) => {
          if (!onOpen) return;
          e.preventDefault();
          onOpen(landing.commit);
        }}
      >
        <strong>{landing.title || shortSha(landing.commit)}</strong>
      </a>
      <span className="source-meta">
        <code>{shortSha(landing.commit)}</code> on main ·{' '}
        {landing.author && (
          <>
            <Person principal={landing.author} /> ·{' '}
          </>
        )}
        landed v{landing.version} · {when(landing.landed_at)}
      </span>
    </>
  );
}

function ChangeRow({
  change: c,
  href,
  onOpen,
}: {
  change: Change;
  href: string;
  onOpen: (n: number) => void;
}) {
  return (
    <>
      <ChangeStatusChip status={c.status} state={landingState(c)} />
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          onOpen(c.number);
        }}
      >
        <strong>{c.title}</strong> <span className="source-meta">#{c.number}</span>
      </a>
      <span className="source-meta">
        <code>{c.branch}</code> → {c.base} · <Person principal={c.author} /> ·{' '}
        {c.status === 'landed' && c.landed_version !== null ? `landed v${c.landed_version} · ` : ''}
        updated {when(c.updated_at)}
        {c.comment_count > 0 && ` · ${c.comment_count} comment${c.comment_count === 1 ? '' : 's'}`}
      </span>
    </>
  );
}

export function ChangeTable({
  changes,
  filter,
  hrefOf,
  onOpen,
  commitHrefOf = (id) => `#${id}`,
  onCommit,
}: {
  changes: Loaded<ChangeList>;
  filter: ChangeFilter;
  hrefOf: (n: number) => string;
  onOpen: (n: number) => void;
  commitHrefOf?: (id: string) => string;
  onCommit?: (id: string) => void;
}) {
  if (changes.loading && !changes.data) return <Loading what="Landings" />;
  if (changes.error) return <Failure error={changes.error} onRetry={changes.reload} />;
  const rows = landingRows(changes.data ?? { changes: [] });
  if (rows.length === 0) return <p className="source-empty">{EMPTY[filter]}</p>;
  return (
    <ul className="source-changes" aria-label={`${filter} Landings`} aria-busy={changes.loading}>
      {rows.map((row) => (
        <li key={row.key}>
          {row.kind === 'direct' ? (
            <DirectRow
              landing={row.landing}
              href={commitHrefOf(row.landing.commit)}
              onOpen={onCommit}
            />
          ) : (
            <ChangeRow change={row.change} href={hrefOf(row.change.number)} onOpen={onOpen} />
          )}
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
  commitHrefOf,
  onCommit,
  initialFilter = 'open',
}: {
  repo: string;
  onOpen: (n: number) => void;
  hrefOf?: (n: number) => string;
  commitHrefOf?: (id: string) => string;
  onCommit?: (id: string) => void;
  initialFilter?: ChangeFilter;
}) {
  const [filter, setFilter] = useState<ChangeFilter>(initialFilter);
  const changes = useSource<ChangeList>(changesPath(repo, filter));
  return (
    <section aria-labelledby="changes-heading">
      <div className="source-changes-head">
        <h2 id="changes-heading">Landings</h2>
        <StatusFilter value={filter} onChange={setFilter} />
      </div>
      <ChangeTable
        changes={changes}
        filter={filter}
        hrefOf={hrefOf}
        onOpen={onOpen}
        commitHrefOf={commitHrefOf}
        onCommit={onCommit}
      />
    </section>
  );
}
