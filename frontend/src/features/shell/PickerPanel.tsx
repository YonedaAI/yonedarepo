// The repository picker's popup: the search (a combobox over the listbox), the groups of rows
// and the footer. A row's heart is for the pointer, hidden from assistive technology so the
// listbox holds only options; RepoPicker gives it its keyboard and screen-reader ways in.
import { Check, Heart, Plus } from 'lucide-react';
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode, Ref } from 'react';
import type { SourceRoute } from '../source-platform/sourceRoute';
import { fullName, optionLabel, type PickerGroup } from './pickerModel';
import type { RepoRow } from './repoRows';
import { linkTo, type Navigate } from './useRoute';

export const repoHome = (repo: string): SourceRoute => ({
  view: 'files',
  repo,
  path: '',
  ref: 'main',
});

/** The DOM id of `row`'s option in the picker `id`. */
export const optionDomId = (id: string, row: RepoRow) => `${id}-${row.repo}`;

export function HeartButton({
  name,
  on,
  inList = false,
  onToggle,
}: {
  name: string;
  on: boolean;
  inList?: boolean;
  onToggle: () => void;
}) {
  const press = (event: MouseEvent) => {
    event.stopPropagation();
    onToggle();
  };
  return (
    <button
      type="button"
      className={`picker-heart${on ? ' on' : ''}`}
      title={on ? 'Remove from favorites' : 'Add to favorites'}
      onClick={press}
      // Pressing a row's heart leaves focus in the search.
      {...(inList
        ? {
            'aria-hidden': true,
            tabIndex: -1,
            onMouseDown: (event: MouseEvent) => event.preventDefault(),
          }
        : { 'aria-label': `Favorite ${name}`, 'aria-pressed': on })}
    >
      <Heart size={15} fill={on ? 'currentColor' : 'none'} aria-hidden="true" />
    </button>
  );
}

export function PickerPanel({
  id,
  ref,
  style,
  query,
  onQuery,
  groups,
  active,
  current,
  favorites,
  onActive,
  onFlip,
  pick,
  empty,
  note,
  trouble,
  said,
  onKeys,
  onPanelKeys,
  onNew,
}: {
  id: string;
  /** The search box. */
  ref: Ref<HTMLInputElement>;
  style?: CSSProperties;
  query: string;
  onQuery: (query: string) => void;
  groups: PickerGroup[];
  /** The row Enter would open. */
  active?: RepoRow;
  current?: string;
  favorites: ReadonlySet<string>;
  onActive: (repo: string) => void;
  onFlip: (row: RepoRow) => void;
  pick: Navigate;
  /** What to say when no row shows. */
  empty: string;
  note: string;
  /** A failed save. */
  trouble: ReactNode;
  /** The last change, for a screen reader. */
  said: string;
  onKeys: (event: KeyboardEvent<HTMLInputElement>) => void;
  onPanelKeys: (event: KeyboardEvent<HTMLElement>) => void;
  onNew?: () => void;
}) {
  return (
    <div
      className="picker-panel"
      id={`${id}-panel`}
      role="dialog"
      aria-label="Find repositories"
      style={style}
      onKeyDown={onPanelKeys}
    >
      <input
        ref={ref}
        type="search"
        role="combobox"
        aria-label="Find repositories"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={`${id}-list`}
        aria-activedescendant={active && optionDomId(id, active)}
        aria-describedby={`${id}-hint`}
        placeholder="Find repositories…"
        autoComplete="off"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={onKeys}
      />
      <span className="sr-only" id={`${id}-hint`}>
        Shift+Enter adds or removes a favorite.
      </span>
      <div className="picker-list" id={`${id}-list`} role="listbox" aria-label="Repositories">
        {groups.map((group) => (
          // biome-ignore lint/a11y/useSemanticElements: a group of options, not form fields.
          <div key={group.label} role="group" aria-label={group.label}>
            {groups.length > 1 && (
              <p className="picker-group" aria-hidden="true">
                {group.label}
              </p>
            )}
            {group.rows.map((row) => (
              <div key={row.repo} className="picker-item">
                <a
                  id={optionDomId(id, row)}
                  className={`picker-option${row === active ? ' active' : ''}`}
                  role="option"
                  aria-selected={row.repo === current}
                  aria-label={optionLabel(row, favorites.has(row.repo))}
                  tabIndex={-1}
                  onMouseMove={() => onActive(row.repo)}
                  {...linkTo(repoHome(row.repo), pick)}
                >
                  <span className="picker-option-name" title={fullName(row)}>
                    {fullName(row)}
                  </span>
                  {row.public && (
                    <small className="picker-public" aria-hidden="true">
                      Public
                    </small>
                  )}
                  {row.repo === current && <Check size={14} aria-hidden="true" />}
                </a>
                <HeartButton
                  name={row.name}
                  on={favorites.has(row.repo)}
                  inList
                  onToggle={() => onFlip(row)}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
      {!groups.length && (
        <p className="picker-empty" role="status">
          {empty}
        </p>
      )}
      {note && (
        <p className="picker-error" role="status">
          {note}
        </p>
      )}
      {trouble}
      <p className="sr-only" role="status">
        {said}
      </p>
      <div className="picker-foot">
        {onNew && (
          <button type="button" onClick={onNew}>
            <Plus size={15} aria-hidden="true" />
            New repository
          </button>
        )}
        <a {...linkTo({ view: 'repositories' }, pick)}>View all repositories</a>
      </div>
    </div>
  );
}
