import {
  BookOpen,
  Bot,
  ExternalLink,
  GitBranch,
  KeyRound,
  LogOut,
  Menu,
  Plus,
  Terminal,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { useRepository } from '../../hooks/useRepository';
import { api } from '../../lib/api';
import type { WorkspacePanel } from './WorkspacePanels';

export function WorkspaceRail({
  state,
  onPanel,
}: {
  state: ReturnType<typeof useRepository>;
  onPanel: (panel: WorkspacePanel) => void;
}) {
  const [open, setOpen] = useState(false);
  function show(panel: WorkspacePanel) {
    onPanel(panel);
    setOpen(false);
  }
  return (
    <aside className={`rail${open ? ' rail-open' : ''}`}>
      <div className="rail-brand-row">
        <a className="brand" href="/">
          <span className="brand-glyph">y</span>
          <span>
            YonedaRepo<small>Context for what comes next.</small>
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
          <p className="nav-label">Workspace</p>
          {state.repositories.map((repo) => (
            <button
              type="button"
              className={repo.id === state.id ? 'active' : ''}
              aria-current={repo.id === state.id ? 'page' : undefined}
              key={repo.id}
              onClick={() => {
                state.setId(repo.id);
                setOpen(false);
              }}
            >
              <GitBranch size={17} />
              <span>{repo.name}</span>
            </button>
          ))}
          {!state.repositories.length && (
            <span className="rail-empty">
              {state.loading
                ? 'Loading repositories…'
                : state.authenticated
                  ? 'No repositories yet'
                  : 'Your repositories live here.'}
            </span>
          )}
          {state.authenticated && (
            <button type="button" className="rail-new" onClick={() => show('project')}>
              <Plus size={17} />
              New repository
            </button>
          )}
        </nav>
        {state.authenticated && (
          <nav className="rail-connections" aria-label="Connections">
            <p className="nav-label">Connections</p>
            <button type="button" onClick={() => show('providers')}>
              <Bot size={17} />
              Agent providers
            </button>
            {state.snapshot && (
              <button type="button" onClick={() => show('agents')}>
                <Terminal size={17} />
                Connect local agent
              </button>
            )}
          </nav>
        )}
        <div className="rail-bottom">
          <button type="button" onClick={() => show('guide')}>
            <BookOpen size={17} />
            How it works
          </button>
          <a href="https://github.com/MagnetonIO/yonedarepo" target="_blank" rel="noreferrer">
            <ExternalLink size={16} />
            Source code
          </a>
          <details>
            <summary>Workspace options</summary>
            <button type="button" onClick={() => show('owner')}>
              <KeyRound size={16} />
              Administrator access
            </button>
            {state.authenticated && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await api('auth/logout', {});
                    await fetch('/api/session', { method: 'DELETE' });
                    state.clear();
                  } catch (error) {
                    state.setError((error as Error).message);
                  }
                }}
              >
                <LogOut size={16} />
                Sign out
              </button>
            )}
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
