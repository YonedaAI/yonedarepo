import { Bot, GitBranch, KeyRound, LoaderCircle, Menu, Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { useRepository } from '../../hooks/useRepository';
import type { RepoRow } from '../shell/repoRows';
import { linkTo, type Navigate } from '../shell/useRoute';
import type { SourceRoute } from '../source-platform/sourceRoute';
import type { WorkspacePanel } from './WorkspacePanels';

const rowRoute = (row: RepoRow): SourceRoute =>
  row.repo
    ? { view: 'files', repo: row.repo, path: '', ref: 'main' }
    : { view: 'home', project: row.project?.id };

export function WorkspaceRail({
  reviewer = false,
  state,
  rows = [],
  rowsError = '',
  current,
  navigate = () => {},
  onNew,
  onPanel,
}: {
  reviewer?: boolean;
  state: ReturnType<typeof useRepository>;
  rows?: RepoRow[];
  rowsError?: string;
  /** The selected row's key. */
  current?: string;
  navigate?: Navigate;
  onNew?: () => void;
  onPanel: (panel: WorkspacePanel) => void;
}) {
  const [open, setOpen] = useState(false);
  function show(panel: WorkspacePanel) {
    onPanel(panel);
    setOpen(false);
  }
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
              key={row.key}
              className={row.key === current ? 'active' : ''}
              aria-current={row.key === current ? 'page' : undefined}
              title={row.shared ? `${row.name} (${row.shared})` : row.name}
              {...linkTo(rowRoute(row), close)}
            >
              {row.repo ? (
                <GitBranch size={17} aria-hidden="true" />
              ) : (
                <LoaderCircle size={17} aria-hidden="true" />
              )}
              <span className="rail-repo-name">{row.name}</span>
              {row.shared && <small className="rail-repo-shared">{row.shared}</small>}
            </a>
          ))}
          {!rows.length && (
            <span className="rail-empty">
              {rowsError ||
                (state.loading
                  ? 'Loading repositories…'
                  : state.authenticated
                    ? 'No repositories yet'
                    : 'Your repositories live here.')}
            </span>
          )}
          {state.authenticated && !reviewer && onNew && (
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
        {state.authenticated && !reviewer && (
          <nav className="rail-connections" aria-label="Connections">
            <p className="nav-label">Connections</p>
            <button type="button" onClick={() => show('agents')}>
              <Bot size={17} />
              Connect Agents
            </button>
          </nav>
        )}
        <div className="rail-bottom">
          <details>
            <summary>Workspace options</summary>
            <button type="button" onClick={() => show('owner')}>
              <KeyRound size={16} />
              Administrator access
            </button>
          </details>
          <span className="environment">
            <i />
            Built on Cloudflare
          </span>
        </div>
      </div>
    </aside>
  );
}
