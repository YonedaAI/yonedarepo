// The repository picker's model: its groups, this browser's recent repositories, the
// shortcut that opens it and where its popup goes. Favorites live on the account
// (useFavorites); recents are a convenience of one browser, and rows filter them, so another
// account signing in here sees none of the last one's.
import { matchRows, type RepoRow } from './repoRows';

export type PickerGroup = { label: 'Favorites' | 'Recent' | 'Repositories'; rows: RepoRow[] };

export const RECENT_LIMIT = 10;
const RECENT_KEY = 'yoneda.recent-repositories';
const POPUP_WIDTH = 340;
const GUTTER = 16;
/** The least height the popup keeps: the search, a few rows and its footer. */
const POPUP_MIN = 300;

const store = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

/** The repositories opened here, newest first; nothing when storage refuses. */
export function readRecents(storage = store()): string[] {
  try {
    const held: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(held) ? held.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function saveRecent(repo: string, storage = store()) {
  const recents = [repo, ...readRecents(storage).filter((id) => id !== repo)];
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(recents.slice(0, RECENT_LIMIT)));
  } catch {
    // A refused write only forgets this visit.
  }
}

/** `rows` and the favorites that are in none of them (another account's public repository). */
export function withFavoriteRows(rows: RepoRow[], favorites: RepoRow[]): RepoRow[] {
  const known = new Set(rows.map((r) => r.repo));
  return [...rows, ...favorites.filter((r) => !known.has(r.repo))];
}

/** Favorites, then Recent (newest first), then the rest: `query`'s matches, each once, in
 * groups that have any. */
export function pickerGroups(
  rows: RepoRow[],
  favorites: ReadonlySet<string>,
  recents: string[],
  query: string,
): PickerGroup[] {
  const shown = matchRows(rows, query);
  const byId = new Map(shown.map((r) => [r.repo, r]));
  const recent = recents.flatMap((id) => {
    const row = byId.get(id);
    return row && !favorites.has(id) ? [row] : [];
  });
  const groups: PickerGroup[] = [
    { label: 'Favorites', rows: shown.filter((r) => favorites.has(r.repo)) },
    { label: 'Recent', rows: recent },
    {
      label: 'Repositories',
      rows: shown.filter((r) => !favorites.has(r.repo) && !recent.includes(r)),
    },
  ];
  return groups.filter((g) => g.rows.length);
}

/** A row's `owner/name`, or its name when it is the viewer's own. */
export const fullName = (row: RepoRow) =>
  row.owner && !row.own ? `${row.owner}/${row.name}` : row.name;

/** An option's spoken name, when it has more to say than its visible name. */
export function optionLabel(row: RepoRow, favorite: boolean) {
  const labels = [row.public && 'public', favorite && 'favorite'].filter(Boolean);
  return labels.length ? [fullName(row), ...labels].join(', ') : undefined;
}

/** Whether a key press asks for the picker: Cmd or Ctrl and K, unless the viewer is typing or
 * in a dialog. */
export function pickerShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'target'>,
) {
  if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return false;
  if (event.altKey || event.shiftKey) return false;
  const on = event.target as Partial<Element> | null;
  return !on?.closest?.('input, textarea, select, [contenteditable], dialog, [role="dialog"]');
}

export type PopupPlace = { top: number; left: number; maxHeight: number };

/** The popup under the row `box`, inside a window of the given size. It is wider than the
 * sidebar, so it is placed on the window rather than in the sidebar's scroller. */
export function popupPlace(
  box: Pick<DOMRect, 'left' | 'bottom'>,
  width: number,
  height: number,
): PopupPlace {
  const room = Math.min(POPUP_WIDTH, width - 2 * GUTTER);
  const top = Math.max(GUTTER, Math.min(box.bottom + 4, height - POPUP_MIN - GUTTER));
  return {
    top,
    left: Math.max(GUTTER, Math.min(box.left, width - room - GUTTER)),
    maxHeight: height - top - GUTTER,
  };
}
