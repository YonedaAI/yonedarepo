import { Building2, GitBranch, Menu, Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { RepoRow } from '../shell/repoRows';
import { linkTo, type Navigate } from '../shell/useRoute';
import type { OrgSummary } from '../source-platform/orgModel';

export function WorkspaceRail({
  authenticated,
  loading,
  rows = [],
  rowsError = '',
  orgs = [],
  current,
  currentOrg,
  navigate = () => {},
  onNew,
}: {
  authenticated: boolean;
  loading: boolean;
  rows?: RepoRow[];
  rowsError?: string;
  /** The account's organizations. */
  orgs?: OrgSummary[];
  /** The selected repository. */
  current?: string;
  /** The organization whose page is open. */
  currentOrg?: string;
  navigate?: Navigate;
  onNew?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close: Navigate = (route, options) => {
    navigate(route, options);
    setOpen(false);
  };
  return (
    <aside className={`rail${open ? ' rail-open' : ''}`}>
      <div className="rail-brand-row">
        <a className="brand" {...linkTo({ view: 'home' }, close)}>
          <span className="brand-glyph">y</span>
          <span>
            YonedaRepo<small>Agent-First Repository</small>
          </span>
        </a>
        <button
          type="button"
          className="icon-button mobile-menu"
          aria-label={open ? 'Close navigation' : 'Open navigation'}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>
      <div className="rail-content">
        <nav className="repository-list" aria-label="Repositories">
          <p className="nav-label">Repositories</p>
          {rows.map((row) => (
            <a
              key={row.repo}
              className={row.repo === current ? 'active' : ''}
              aria-current={row.repo === current ? 'page' : undefined}
              title={row.shared ? `${row.name} (${row.shared})` : row.name}
              {...linkTo({ view: 'files', repo: row.repo, path: '', ref: 'main' }, close)}
            >
              <GitBranch size={17} aria-hidden="true" />
              <span className="rail-repo-name">{row.name}</span>
              {row.shared && <small className="rail-repo-shared">{row.shared}</small>}
            </a>
          ))}
          {!rows.length && (
            <span className="rail-empty">
              {rowsError ||
                (loading
                  ? 'Loading repositories…'
                  : authenticated
                    ? 'No repositories yet'
                    : 'Your repositories live here.')}
            </span>
          )}
          {authenticated && onNew && (
            <button
              type="button"
              className="rail-new"
              onClick={() => {
                onNew();
                setOpen(false);
              }}
            >
              <Plus size={17} />
              New repository
            </button>
          )}
        </nav>
        {orgs.length > 0 && (
          <nav className="repository-list" aria-label="Organizations">
            <p className="nav-label">Organizations</p>
            {orgs.map((o) => (
              <a
                key={o.org}
                className={o.org === currentOrg ? 'active' : ''}
                aria-current={o.org === currentOrg ? 'page' : undefined}
                {...linkTo({ view: 'org', org: o.org }, close)}
              >
                <Building2 size={17} aria-hidden="true" />
                <span className="rail-repo-name">{o.org}</span>
                <small className="rail-repo-shared">{o.role}</small>
              </a>
            ))}
          </nav>
        )}
        <div className="rail-bottom">
          <span className="environment">
            <i />
            Built on Cloudflare
          </span>
        </div>
      </div>
    </aside>
  );
}
