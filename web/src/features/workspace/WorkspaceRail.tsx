import { BookOpen, ExternalLink, GitBranch, KeyRound } from 'lucide-react';
import type { useRepository } from '../../hooks/useRepository';
import { api } from '../../lib/api';
export function WorkspaceRail({
  state,
  showGuide,
  onProject,
  onAgents,
  onSettings,
  onAuth,
  onGuide,
  onRepository,
}: {
  state: ReturnType<typeof useRepository>;
  showGuide: boolean;
  onProject: () => void;
  onAgents: () => void;
  onSettings: () => void;
  onAuth: () => void;
  onGuide: () => void;
  onRepository: () => void;
}) {
  return (
    <aside className="rail">
      <a className="brand" href="/">
        <span className="brand-glyph">y</span>
        <span>
          YonedaRepo<small>Context for what comes next.</small>
        </span>
      </a>
      {state.authenticated && (
        <button className="add-project" type="button" onClick={() => onProject()}>
          Add repository
        </button>
      )}
      <div className="repository-list">
        <p>Repositories</p>
        {state.repositories.map((repo) => (
          <button
            type="button"
            className={repo.id === state.id ? 'active' : ''}
            key={repo.id}
            onClick={() => {
              state.setId(repo.id);
              onRepository();
            }}
          >
            <GitBranch size={17} />
            {repo.name}
          </button>
        ))}
        {!state.repositories.length && (
          <span className="rail-empty">
            {state.loading
              ? 'Loading workspace…'
              : state.authenticated
                ? 'No repositories added yet'
                : 'Sign in to see your repositories'}
          </span>
        )}
      </div>
      <div className="rail-bottom">
        <span className="environment">
          <i />
          Development workspace
        </span>
        {state.authenticated && (
          <>
            {state.snapshot && (
              <button type="button" onClick={onAgents}>
                Connect local agent
              </button>
            )}
            <button type="button" onClick={() => onSettings()}>
              Agent providers
            </button>
            <button
              type="button"
              onClick={async () => {
                await api('auth/logout', {});
                await fetch('/api/session', { method: 'DELETE' });
                state.clear();
              }}
            >
              Sign out
            </button>
          </>
        )}
        <button type="button" onClick={() => onAuth()}>
          <KeyRound size={16} />
          Administrator connection
        </button>
        <button type="button" aria-expanded={showGuide} onClick={() => onGuide()}>
          <BookOpen size={16} />
          Demo guide
        </button>
        <a href="https://github.com/cloudflare/artifacts" target="_blank" rel="noreferrer">
          <ExternalLink size={14} />
          Built on Cloudflare
        </a>
      </div>
    </aside>
  );
}
