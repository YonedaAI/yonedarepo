// A repository inside the shell: name, status chips, tabs and the current tab's view.
import type { ReactNode } from 'react';
import type { Repository } from '../../lib/types';
import { RepoSettings } from '../repo-settings/RepoSettings';
import type { Navigate } from '../shell/useRoute';
import { CommitView } from './CommitView';
import { HistoryTab } from './HistoryTab';
import { RepoFiles } from './RepoFiles';
import { RepoOverview } from './RepoOverview';
import { RepoSearch } from './RepoSearch';
import { RepoTabs, StatusChips } from './RepoTabs';
import type { RepoStatus } from './repoStatus';
import { Failure } from './SourceStatus';
import { routeTab, type SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

type RepoRoute = Extract<SourceRoute, { repo: string }>;

export function RepoPage({
  route,
  name,
  project,
  navigate,
  runs,
  agentContext,
  onDeleted,
  onDeleteProject,
}: {
  route: RepoRoute;
  /** The name the sidebar shows, until the repository's own status loads. */
  name?: string;
  project?: Repository;
  navigate: Navigate;
  /** The Runs tab's content (only with an agent project). */
  runs?: ReactNode;
  agentContext?: ReactNode;
  onDeleted: () => void;
  onDeleteProject: (project: Repository) => void;
}) {
  const repo = route.repo;
  const status = useSource<RepoStatus>(`/repos/${repo}`);
  const data = status.data;
  const owner = data?.viewer?.owner === true;
  const drift = data?.projections?.filter((p) => p.status === 'drift') ?? [];
  return (
    <div className="repo-page">
      <div className="repo-head">
        <h1>{project?.name ?? name ?? data?.name ?? repo}</h1>
        {data && <StatusChips repo={repo} status={data} owner={owner} navigate={navigate} />}
      </div>
      {drift.map((p) => (
        <p key={p.refname} role="alert" className="source-error">
          {p.refname.replace(/^refs\/heads\//, '')} in the Git object store has drifted from the
          landed branch and is no longer updated: {p.detail}
        </p>
      ))}
      {status.error && <Failure error={status.error} onRetry={status.reload} />}
      {!status.error && (
        <>
          <RepoTabs
            repo={repo}
            current={routeTab(route)}
            runs={!!project}
            settings={owner}
            navigate={navigate}
          />
          <div className="repo-view">
            {route.view === 'files' && (
              <RepoFiles route={route} status={data} navigate={navigate} />
            )}
            {route.view === 'overview' && <RepoOverview route={route} onNavigate={navigate} />}
            {(route.view === 'history' || route.view === 'transactions') && (
              <HistoryTab
                route={route}
                status={data}
                navigate={navigate}
                agentContext={agentContext}
              />
            )}
            {route.view === 'commit' && (
              <CommitView
                key={route.commit}
                repo={repo}
                commit={route.commit}
                onNavigate={navigate}
                onChanged={status.reload}
              />
            )}
            {route.view === 'search' && (
              <RepoSearch key={route.query} repo={repo} query={route.query} onNavigate={navigate} />
            )}
            {route.view === 'runs' &&
              (runs ?? (
                <div className="source-empty-state">
                  <p>
                    Runs belong to repositories created with agent runs. This repository is used
                    through Git, the CLI and MCP.
                  </p>
                </div>
              ))}
            {route.view === 'repo-settings' && (
              <RepoSettings
                repo={repo}
                section={route.section}
                status={data}
                project={project}
                navigate={navigate}
                onPolicySaved={status.reload}
                onDeleted={onDeleted}
                onDeleteProject={onDeleteProject}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
