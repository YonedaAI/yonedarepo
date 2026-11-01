// Repositories deleted and not yet purged (`GET /repos/deleted`, an org's at
// `/orgs/:org/repos/deleted`): days left and Restore, for those who may delete them. The server
// decides all of it. A repository whose name was taken meanwhile asks for a new one here. Where
// the window is off the list is empty and nothing offers an undo; what it promised while it was
// on still shows.
import { type FormEvent, useState } from 'react';
import { Failure, Loading } from './SourceStatus';
import { SourceApiError, sourceApi, when } from './sourceApi';
import { type Loaded, useSource } from './useSource';

const DAY_MS = 86_400_000;

export type DeletedRepo = {
  id: string;
  name: string;
  owner: string;
  visibility: string;
  created_at: number;
  deleted_at: number;
  purge_at: number;
};
export type Deleted = { window_days: number; repos: DeletedRepo[] };

/** Days until `purgeAt`, rounded up; 0 once it is due. */
export const daysLeft = (purgeAt: number, now: number) =>
  Math.max(0, Math.ceil((purgeAt - now) / DAY_MS));

export function leftLabel(purgeAt: number, now: number) {
  const days = daysLeft(purgeAt, now);
  if (days === 0) return 'Purge due now';
  return `${days} ${days === 1 ? 'day' : 'days'} left`;
}

/** How many days a deleted repository can be restored here (0: none, or not read yet). */
export const useUndoDays = (ask = true) =>
  Math.ceil(useSource<Deleted>(ask ? '/repos/deleted' : null).data?.window_days ?? 0);

function DeletedRow({
  repo,
  now,
  onChanged,
}: {
  repo: DeletedRepo;
  now: number;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The name was taken meanwhile: it comes back under the one typed here.
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  async function restore(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = renaming ? { name: name.trim() } : {};
      await sourceApi(`/repos/${repo.id}/restore`, { body });
      onChanged();
    } catch (e) {
      const taken = e instanceof SourceApiError && e.code === 'NAME_TAKEN';
      setRenaming(renaming || taken);
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <li>
      <strong>{repo.name}</strong>{' '}
      <span className="source-meta">
        deleted {when(repo.deleted_at)} · {leftLabel(repo.purge_at, now)}
      </span>{' '}
      {!renaming && (
        <button
          type="button"
          className="quiet"
          aria-label={`Restore ${repo.name}`}
          disabled={busy}
          onClick={() => void restore()}
        >
          {busy ? 'Restoring…' : 'Restore'}
        </button>
      )}
      {renaming && (
        <form onSubmit={restore} className="source-create" aria-label={`Restore ${repo.name}`}>
          <label htmlFor={`restore-name-${repo.id}`} className="sr-only">
            New name for {repo.name}
          </label>
          <input
            id={`restore-name-${repo.id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New name"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Restoring…' : 'Restore under this name'}
          </button>
        </form>
      )}
      {error && <Failure error={error} />}
    </li>
  );
}

export function DeletedList({
  deleted,
  now = Date.now(),
  onChanged,
}: {
  deleted: Deleted;
  now?: number;
  onChanged: () => void;
}) {
  const { window_days: days, repos } = deleted;
  if (repos.length === 0)
    return (
      <p className="source-empty">
        {days > 0
          ? `Nothing deleted in the last ${Math.ceil(days)} ${days > 1 ? 'days' : 'day'}.`
          : 'Nothing here.'}
      </p>
    );
  return (
    <ul className="org-repos">
      {repos.map((repo) => (
        <DeletedRow key={repo.id} repo={repo} now={now} onChanged={onChanged} />
      ))}
    </ul>
  );
}

/** A loaded list: its loading and error states, then `DeletedList`. */
export function RecentlyDeleted({
  loaded,
  onRestored,
}: {
  loaded: Loaded<Deleted>;
  /** Something else lists repositories on this page. */
  onRestored?: () => void;
}) {
  if (loaded.loading && !loaded.data) return <Loading what="deleted repositories" />;
  if (loaded.error || !loaded.data)
    return <Failure error={loaded.error ?? 'Could not read the list'} onRetry={loaded.reload} />;
  const changed = () => {
    loaded.reload();
    onRestored?.();
  };
  return <DeletedList deleted={loaded.data} onChanged={changed} />;
}

/** The account's own, on its settings page. */
export function AccountDeleted({ onRestored }: { onRestored?: () => void }) {
  return <RecentlyDeleted loaded={useSource<Deleted>('/repos/deleted')} onRestored={onRestored} />;
}
