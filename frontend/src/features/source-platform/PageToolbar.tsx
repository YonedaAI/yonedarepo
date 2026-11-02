// The row at the top of a repository page: the view's name or filter on the left, then search,
// filter and one primary button on the right. Search leads to the repository's Search page;
// filter opens a small panel, so a page's filters never fill the row.
import { ListFilter, Search } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { useMenuDismiss } from '../shell/menuDismiss';
import { linkTo, type Navigate } from '../shell/useRoute';

function ToolbarFilter({ filtered, children }: { filtered: number; children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  useMenuDismiss(menu);
  return (
    <details
      ref={menu}
      className="toolbar-filter"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }}
    >
      <summary
        className="toolbar-icon"
        aria-label={filtered ? `Filter: ${filtered} on` : 'Filter'}
        title="Filter"
      >
        <ListFilter size={16} aria-hidden="true" />
        {filtered > 0 && <span className="toolbar-count">{filtered}</span>}
      </summary>
      <div className="toolbar-filter-panel">{children}</div>
    </details>
  );
}

export function PageToolbar({
  title,
  headingId,
  view,
  search,
  filters,
  filtered = 0,
  extra,
  primary,
}: {
  /** The view's name: shown unless `view` takes its place, and always there for screen readers. */
  title?: string;
  headingId?: string;
  /** What stands on the left instead of the name: the page's main filter or its tabs. */
  view?: ReactNode;
  /** The repository the search button searches. */
  search?: { repo: string; navigate: Navigate };
  /** The fields of the filter panel; without them there is no filter button. */
  filters?: ReactNode;
  /** How many of those filters are on. */
  filtered?: number;
  /** A quiet control that belongs to the view, such as Refresh. */
  extra?: ReactNode;
  primary?: ReactNode;
}) {
  return (
    <div className="page-toolbar">
      <div className="page-toolbar-view">
        {title && (
          <h2 id={headingId} className={view ? 'sr-only' : undefined}>
            {title}
          </h2>
        )}
        {view}
      </div>
      <div className="page-toolbar-actions">
        {extra}
        {search && (
          <a
            className="toolbar-icon"
            title="Search"
            {...linkTo({ view: 'search', repo: search.repo, query: '' }, search.navigate)}
          >
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Search this repository</span>
          </a>
        )}
        {filters && <ToolbarFilter filtered={filtered}>{filters}</ToolbarFilter>}
        {primary}
      </div>
    </div>
  );
}
