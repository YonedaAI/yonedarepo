// The sidebar's repository picker: the open repository, its favorite heart, and a popup with
// a search over Favorites, Recent and the rest. Focus stays in the search (a combobox over a
// listbox): Up and Down move through the rows, Enter opens one, Tab reaches the footer, and
// Escape closes and returns focus. A row's heart is for the pointer (PickerPanel): Shift+Enter
// and the closed row's heart are its keyboard and screen-reader ways in. Signed out it is the
// open repository's name alone.
import { ChevronsUpDown, GitBranch } from 'lucide-react';
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { HeartButton, optionDomId, PickerPanel, repoHome } from './PickerPanel';
import {
  type PopupPlace,
  pickerGroups,
  popupPlace,
  readRecents,
  withFavoriteRows,
} from './pickerModel';
import type { RepoRow } from './repoRows';
import type { Favorites } from './useFavorites';
import type { Navigate } from './useRoute';

const NONE: ReadonlySet<string> = new Set();

export function RepoPicker({
  rows,
  current,
  currentName,
  loading = false,
  error = '',
  favorites,
  open,
  onOpenChange,
  navigate,
  onNew,
}: {
  rows: RepoRow[];
  /** The open repository's id. */
  current?: string;
  /** Its name, also for a repository that is in no row (another account's public one). */
  currentName?: string;
  loading?: boolean;
  /** Why the repositories could not be read. */
  error?: string;
  /** The account's favorites; a visitor signed out has none, and picks nothing. */
  favorites?: Favorites;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate: Navigate;
  onNew?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string>();
  const [place, setPlace] = useState<PopupPlace>();
  const [said, setSaid] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const returnTo = useRef<Element | null>(null);
  const id = useId();
  const ids = favorites?.ids ?? NONE;
  const all = withFavoriteRows(rows, favorites?.rows ?? []);
  const recents = useMemo(() => (open ? readRecents() : []), [open]);
  const groups = pickerGroups(all, ids, recents, query);
  const shown = groups.flatMap((g) => g.rows);
  const active = shown.find((r) => r.repo === activeId) ?? shown[0];
  const activeOption = open && active ? optionDomId(id, active) : undefined;

  useLayoutEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement;
    setQuery('');
    setActiveId(undefined);
    setSaid('');
    const placed = () => {
      const box = button.current?.getBoundingClientRect();
      if (box) setPlace(popupPlace(box, window.innerWidth, window.innerHeight));
    };
    placed();
    input.current?.focus();
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener('pointerdown', away);
    window.addEventListener('resize', placed);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('resize', placed);
    };
  }, [open, onOpenChange]);
  useEffect(() => {
    if (activeOption) document.getElementById(activeOption)?.scrollIntoView({ block: 'nearest' });
  }, [activeOption]);

  const close = () => {
    onOpenChange(false);
    const back = returnTo.current;
    const opener = back instanceof HTMLElement && back.isConnected && back !== document.body;
    (opener ? back : button.current)?.focus();
  };
  const pick: Navigate = (route, options) => {
    navigate(route, options);
    close();
  };
  const flip = (row: RepoRow) => {
    if (!favorites) return;
    const adding = !ids.has(row.repo);
    const known = rows.some((r) => r.repo === row.repo) || !adding;
    if (favorites.toggle(row.repo, known))
      setSaid(`${row.name} ${adding ? 'added to' : 'removed from'} favorites`);
  };
  const searchKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      if (!active) return;
      const next = shown[(shown.indexOf(active) + step + shown.length) % shown.length];
      setActiveId(next?.repo);
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      if (event.shiftKey) flip(active);
      else pick(repoHome(active.repo));
    }
  };
  const panelKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    // Stops here: on a phone Escape would close the navigation menu as well.
    event.stopPropagation();
    close();
  };

  const name = current ? (currentName ?? rows.find((r) => r.repo === current)?.name) : undefined;
  if (!favorites)
    return name ? (
      <p className="picker-static" title={name}>
        <GitBranch size={15} aria-hidden="true" />
        <span className="picker-name">{name}</span>
      </p>
    ) : null;
  const trouble = favorites.error && (
    <p className="picker-error" role="alert">
      {favorites.error}
    </p>
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a focus handler; it takes no input.
    <div
      className="repo-picker"
      ref={root}
      onBlur={(event) => {
        // Tabbed past the popup; a click on its scrollbar moves focus to nothing.
        const to = event.relatedTarget;
        if (open && to && !root.current?.contains(to)) onOpenChange(false);
      }}
    >
      <div className={`picker-row${current ? ' hearted' : ''}`}>
        <button
          ref={button}
          type="button"
          className="picker-button"
          title={name}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? `${id}-panel` : undefined}
          aria-label={name ? `Switch repository (current: ${name})` : 'Choose a repository'}
          onClick={() => (open ? close() : onOpenChange(true))}
        >
          <GitBranch size={15} aria-hidden="true" />
          <span className="picker-name">{name ?? 'Choose a repository'}</span>
          <ChevronsUpDown size={14} aria-hidden="true" />
        </button>
        {current && (
          <HeartButton
            name={name ?? current}
            on={ids.has(current)}
            onToggle={() => flip({ repo: current, name: name ?? current })}
          />
        )}
      </div>
      {!open && trouble}
      {open && (
        <PickerPanel
          id={id}
          ref={input}
          style={place}
          query={query}
          onQuery={(next) => {
            setQuery(next);
            setActiveId(undefined);
          }}
          groups={groups}
          active={active}
          current={current}
          favorites={ids}
          onActive={setActiveId}
          onFlip={flip}
          pick={pick}
          empty={
            query.trim()
              ? `No repository matches “${query.trim()}”.`
              : error
                ? 'Your repositories could not be read.'
                : loading
                  ? 'Loading repositories…'
                  : 'No repositories yet.'
          }
          note={favorites.loadError ? 'Favorites could not be read.' : ''}
          trouble={trouble}
          said={said}
          onKeys={searchKeys}
          onPanelKeys={panelKeys}
          onNew={
            onNew &&
            (() => {
              onOpenChange(false);
              onNew();
            })
          }
        />
      )}
    </div>
  );
}
