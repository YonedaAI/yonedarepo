// Docs search: a box in the docs header (⌘K or Ctrl+K, or `/`) opening a dialog that
// searches every page's titles, headings and text in the browser. Arrow keys move through
// the results, Enter opens one, Escape closes.
import { CornerDownLeft, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type SearchHit, searchDocs } from './docsIndex';

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function DocsSearch({ onOpen }: { onOpen: (hit: SearchHit) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const hits = useMemo(() => searchDocs(query), [query]);
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(isMac()), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof HTMLElement &&
        event.target.closest('input, textarea, [contenteditable]');
      if (
        (event.key === 'k' && (event.metaKey || event.ctrlKey)) ||
        (event.key === '/' && !typing)
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    if (open)
      document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, selected, listId]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setSelected(0);
    opener.current?.focus();
  };
  const choose = (hit: SearchHit) => {
    close();
    onOpen(hit);
  };

  return (
    <>
      <button
        ref={opener}
        type="button"
        className="docs-search-button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <Search size={15} aria-hidden="true" />
        <span>Search docs</span>
        <kbd>{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      {open &&
        // Outside the docs header, whose backdrop filter would confine a fixed overlay to it; inside
        // the site frame, whose tokens it uses.
        createPortal(
          // A press outside the dialog closes it; Escape is the keyboard's way out.
          // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop, not a control.
          <div
            className="docs-search-overlay"
            onMouseDown={(e) => e.target === e.currentTarget && close()}
          >
            <div className="docs-search" role="dialog" aria-modal="true" aria-label="Search docs">
              <div className="docs-search-field">
                <Search size={16} aria-hidden="true" />
                <input
                  ref={input}
                  type="search"
                  role="combobox"
                  aria-expanded={hits.length > 0}
                  aria-controls={listId}
                  aria-activedescendant={hits[selected] ? `${listId}-${selected}` : undefined}
                  aria-autocomplete="list"
                  placeholder="Search titles, headings and text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSelected(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      close();
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setSelected((s) => Math.min(s + 1, hits.length - 1));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setSelected((s) => Math.max(s - 1, 0));
                    } else if (e.key === 'Enter' && hits[selected]) {
                      e.preventDefault();
                      choose(hits[selected]);
                    }
                  }}
                />
                <kbd>Esc</kbd>
              </div>
              {query.trim() && !hits.length && (
                <p className="docs-search-empty">No pages match “{query.trim()}”.</p>
              )}
              {/* The input keeps focus and points at the selected option (aria-activedescendant). */}
              <div id={listId} role="listbox" className="docs-search-results" aria-label="Results">
                {hits.map((hit, n) => (
                  <div
                    key={`${hit.slug}#${hit.anchor}`}
                    id={`${listId}-${n}`}
                    role="option"
                    tabIndex={-1}
                    className="docs-search-option"
                    aria-selected={n === selected}
                    onMouseMove={() => setSelected(n)}
                    onClick={() => choose(hit)}
                    onKeyDown={(e) => e.key === 'Enter' && choose(hit)}
                  >
                    <span className="docs-search-path">
                      {hit.page}
                      {hit.heading && ` › ${hit.heading}`}
                    </span>
                    {hit.snippet && <span className="docs-search-snippet">{hit.snippet}</span>}
                    {n === selected && (
                      <CornerDownLeft className="docs-search-enter" size={14} aria-hidden="true" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>,
          opener.current?.closest('.site') ?? document.body,
        )}
    </>
  );
}
