// The account's favorite repositories: read from the platform, shown at once when toggled,
// and put back with the server's words when a save is refused. One save per repository at a
// time, so a double press cannot race itself.
import { useCallback, useEffect, useRef, useState } from 'react';
import { rememberRepoName } from '../source-platform/repoNames';
import { sourceApi } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import { type PlatformRepo, type RepoRow, repoRows } from './repoRows';

type Ids = ReadonlySet<string>;

export type Favorites = {
  ids: Ids;
  /** Each favorite's row, for those in no list of the account's own. */
  rows: RepoRow[];
  /** Why the last save failed. */
  error: string;
  loadError: string;
  /** Flips `repo`, and answers whether it did (a save of it may be under way). `known`: its
   * row is on hand, so nothing needs reading again. */
  toggle: (repo: string, known: boolean) => boolean;
  reload: () => void;
};

const changed = (ids: Ids, repo: string, on: boolean) => {
  const next = new Set(ids);
  if (on) next.add(repo);
  else next.delete(repo);
  return next;
};

/** Shows the change, then saves it: answers whether it stood. */
export async function saveFavorite(
  repo: string,
  on: boolean,
  update: (change: (ids: Ids) => Ids) => void,
  fail: (message: string) => void,
  request: typeof sourceApi = sourceApi,
) {
  update((ids) => changed(ids, repo, on));
  try {
    await request(`/favorites/${repo}`, { method: on ? 'PUT' : 'DELETE' });
    return true;
  } catch (e) {
    update((ids) => changed(ids, repo, !on));
    fail(e instanceof Error ? e.message : String(e));
    return false;
  }
}

export function useFavorites(authenticated: boolean, self: (string | null | undefined)[]) {
  const listed = useSource<{ favorites: PlatformRepo[] }>(authenticated ? '/favorites' : null);
  const [ids, setIds] = useState<Ids>(new Set());
  const [error, setError] = useState('');
  const saving = useRef(new Set<string>());
  const saved = listed.data?.favorites;
  useEffect(() => {
    if (saved) setIds(new Set(saved.map((f) => f.id)));
  }, [saved]);
  for (const f of saved ?? []) rememberRepoName(f.id, f.owner_handle, f.name);
  const { reload } = listed;
  const toggle = useCallback(
    (repo: string, known: boolean) => {
      if (saving.current.has(repo)) return false;
      saving.current.add(repo);
      setError('');
      const on = !ids.has(repo);
      void saveFavorite(repo, on, setIds, setError).then((stood) => {
        saving.current.delete(repo);
        if (stood && on && !known) reload();
      });
      return true;
    },
    [ids, reload],
  );
  const favorites: Favorites = {
    ids,
    rows: repoRows(saved ?? [], self),
    error,
    loadError: listed.error ?? '',
    toggle,
    reload,
  };
  return favorites;
}
