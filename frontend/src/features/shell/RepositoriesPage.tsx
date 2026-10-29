// Repositories (`/repositories`): every repository the account can use, with a filter.
import { ArrowRight, GitBranch, Plus } from 'lucide-react';
import { useState } from 'react';
import type { Session } from '../../hooks/useSession';
import { PublicBadge } from '../source-platform/PublicBadge';
import { WorkspaceWelcome } from '../workspace/WorkspaceWelcome';
import { matchRows, type RepoRow } from './repoRows';
import { linkTo, type Navigate } from './useRoute';

export function RepositoriesPage({
  session,
  rows,
  rowsLoading,
  rowsError,
  onRetry,
  navigate,
  onNew,
}: {
  session: Session;
  rows: RepoRow[];
  rowsLoading: boolean;
  rowsError: string;
  onRetry: () => void;
  navigate: Navigate;
  onNew: () => void;
}) {
  const [query, setQuery] = useState('');
  if (!session.authenticated || !rows.length)
    return (
      <WorkspaceWelcome
        authenticated={session.authenticated}
        loading={session.loading || (session.authenticated && rowsLoading)}
        error={session.error || rowsError}
        onRetry={onRetry}
        onSignedIn={() => void session.discover()}
        onNew={onNew}
      />
    );
  const shown = matchRows(rows, query);
  return (
    <section className="home-repos" aria-labelledby="repositories-heading">
      <div className="page-heading">
        <h1 id="repositories-heading">Repositories</h1>
        <button type="button" onClick={onNew}>
          <Plus size={17} aria-hidden="true" />
          New repository
        </button>
      </div>
      <input
        type="search"
        className="repo-filter"
        aria-label="Filter repositories"
        placeholder="Filter repositories…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul className="home-repo-list">
        {shown.map((row) => (
          <li key={row.repo}>
            <a {...linkTo({ view: 'files', repo: row.repo, path: '', ref: 'main' }, navigate)}>
              <GitBranch size={18} aria-hidden="true" />
              <span className="home-repo-text">
                <strong className="home-repo-name">
                  {row.name} {row.public && <PublicBadge />}
                </strong>
                <small className="home-repo-meta">{row.shared ?? 'yours'}</small>
              </span>
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
      {!shown.length && (
        <p className="home-empty" role="status">
          No repository matches “{query.trim()}”.
        </p>
      )}
    </section>
  );
}
