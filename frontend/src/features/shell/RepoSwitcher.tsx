// The sidebar's repository switcher: the open repository's name, and a search over the
// account's repositories. Escape closes it and returns focus; Down moves from the search
// into the list, Up and Down move through it.
import { Check, ChevronsUpDown, GitBranch } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { matchRows, type RepoRow } from './repoRows';
import { linkTo, type Navigate } from './useRoute';

export function RepoSwitcher({
  rows,
  current,
  currentName,
  navigate,
  initiallyOpen = false,
}: {
  rows: RepoRow[];
  /** The open repository's id. */
  current?: string;
  /** Its name, also for a repository that is in no row (another account's public one). */
  currentName?: string;
  navigate: Navigate;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [query, setQuery] = useState('');
  const panel = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const shown = matchRows(rows, query);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    setQuery('');
    button.current?.focus();
  };
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    const links = [...(root.current?.querySelectorAll<HTMLElement>('.switcher-list a') ?? [])];
    const at = links.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (step > 0 ? 0 : -1) : at + step;
    event.preventDefault();
    if (next < 0) input.current?.focus();
    else links[Math.min(next, links.length - 1)]?.focus();
  };
  const pick: Navigate = (route, options) => {
    navigate(route, options);
    setOpen(false);
    setQuery('');
  };
  const name = currentName ?? rows.find((r) => r.repo === current)?.name;
  return (
    <div className="repo-switcher" ref={root}>
      <button
        ref={button}
        type="button"
        className="switcher-button"
        aria-expanded={open}
        aria-controls={panel}
        onKeyDown={keys}
        aria-label={name ? `Switch repository (current: ${name})` : 'Choose a repository'}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <GitBranch size={15} aria-hidden="true" />
        <span className="switcher-name">{name ?? 'Choose a repository'}</span>
        <ChevronsUpDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="switcher-panel" id={panel}>
          <input
            ref={input}
            type="search"
            aria-label="Find a repository"
            placeholder="Find a repository…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={keys}
          />
          <ul className="switcher-list">
            {shown.map((row) => (
              <li key={row.repo}>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: linkTo spreads the href, so this is a link. */}
                <a
                  aria-current={row.repo === current ? 'page' : undefined}
                  onKeyDown={keys}
                  {...linkTo({ view: 'files', repo: row.repo, path: '', ref: 'main' }, pick)}
                >
                  <span className="switcher-row-name">{row.name}</span>
                  {row.shared && <small>{row.shared}</small>}
                  {row.repo === current && <Check size={14} aria-hidden="true" />}
                </a>
              </li>
            ))}
          </ul>
          {!shown.length && (
            <p className="switcher-empty" role="status">
              {rows.length ? `No repository matches “${query.trim()}”.` : 'No repositories yet.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
