// Home (`/`): sign-in and onboarding, or every repository the account can use.
import { ArrowRight, GitBranch, Plus } from 'lucide-react';
import type { Session } from '../../hooks/useSession';
import { PublicBadge } from '../source-platform/PublicBadge';
import { WorkspaceWelcome } from '../workspace/WorkspaceWelcome';
import type { RepoRow } from './repoRows';
import { linkTo, type Navigate } from './useRoute';

export function HomePage({
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
  return (
    <section className="home-repos" aria-labelledby="home-heading">
      <div className="page-heading">
        <h1 id="home-heading">Repositories</h1>
        <button type="button" onClick={onNew}>
          <Plus size={17} aria-hidden="true" />
          New repository
        </button>
      </div>
      <ul className="home-repo-list">
        {rows.map((row) => (
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
    </section>
  );
}
