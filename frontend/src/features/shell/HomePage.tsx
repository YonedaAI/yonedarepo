// Home (`/`): sign-in and onboarding, a project still being set up, or every repository.
import { ArrowRight, GitBranch, Plus } from 'lucide-react';
import type { useRepository } from '../../hooks/useRepository';
import { WorkspaceWelcome } from '../workspace/WorkspaceWelcome';
import type { RepoRow } from './repoRows';
import { linkTo, type Navigate } from './useRoute';

export function HomePage({
  state,
  rows,
  setupProject,
  navigate,
  onNew,
  onProviders,
}: {
  state: ReturnType<typeof useRepository>;
  rows: RepoRow[];
  /** A project link (`/?repo=`) to a project whose setup has not finished. */
  setupProject: boolean;
  navigate: Navigate;
  onNew: () => void;
  onProviders: () => void;
}) {
  if (!state.authenticated || setupProject || (!rows.length && !state.loading))
    return <WorkspaceWelcome state={state} onProject={onNew} onProviders={onProviders} />;
  return (
    <section className="home-repos" aria-labelledby="home-heading">
      <div className="page-heading">
        <h1 id="home-heading">Repositories</h1>
        <button type="button" onClick={onNew}>
          <Plus size={17} aria-hidden="true" />
          New repository
        </button>
      </div>
      {!rows.length && <p className="source-empty">Loading repositories…</p>}
      <ul className="home-repo-list">
        {rows.map((row) => (
          <li key={row.key}>
            <a
              {...linkTo(
                row.repo
                  ? { view: 'files', repo: row.repo, path: '', ref: 'main' }
                  : { view: 'home', project: row.project?.id },
                navigate,
              )}
            >
              <GitBranch size={18} aria-hidden="true" />
              <span className="home-repo-text">
                <strong className="home-repo-name">{row.name}</strong>
                <small className="home-repo-meta">
                  {[
                    row.project ? 'agent runs' : 'git',
                    row.shared,
                    row.project && row.project.status !== 'ready' ? row.project.status : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </span>
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
