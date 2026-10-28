// A repository inside the shell: name, status chips, tabs and the current tab's view.
import { RepoSettings } from '../repo-settings/RepoSettings';
import { linkTo, type Navigate } from '../shell/useRoute';
import { ChangeView } from './ChangeView';
import { CommitView } from './CommitView';
import { ForkButton } from './ForkButton';
import { HistoryTab } from './HistoryTab';
import { RepoChanges } from './RepoChanges';
import { RepoFiles } from './RepoFiles';
import { RepoOverview } from './RepoOverview';
import { RepoSearch } from './RepoSearch';
import { RepoTabs, StatusChips } from './RepoTabs';
import type { RepoStatus } from './repoStatus';
import { Failure } from './SourceStatus';
import { formatSourceRoute, routeTab, type SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

type RepoRoute = Extract<SourceRoute, { repo: string }>;

export function RepoPage({
  route,
  name,
  navigate,
  onDeleted,
}: {
  route: RepoRoute;
  /** The name the sidebar shows, until the repository's own status loads. */
  name?: string;
  navigate: Navigate;
  onDeleted: () => void;
}) {
  const repo = route.repo;
  const status = useSource<RepoStatus>(`/repos/${repo}`);
  const data = status.data;
  const owner = data?.viewer?.owner === true;
  const drift = data?.projections?.filter((p) => p.status === 'drift') ?? [];
  return (
    <div className="repo-page">
      <div className="repo-head">
        <h1>{name ?? data?.name ?? repo}</h1>
        {data?.parent && (
          <p className="source-meta">
            forked from{' '}
            <a
              {...linkTo(
                { view: 'files', repo: data.parent.repo, path: '', ref: 'main' },
                navigate,
              )}
            >
              {data.parent.repo}
            </a>{' '}
            at v{data.parent.version}
          </p>
        )}
        {data && <StatusChips repo={repo} status={data} owner={owner} navigate={navigate} />}
        {data && (
          <ForkButton
            repo={repo}
            name={data.name}
            onForked={(fork) => navigate({ view: 'files', repo: fork.id, path: '', ref: 'main' })}
          />
        )}
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
          <RepoTabs repo={repo} current={routeTab(route)} settings={owner} navigate={navigate} />
          <div className="repo-view">
            {route.view === 'files' && (
              <RepoFiles route={route} status={data} navigate={navigate} />
            )}
            {route.view === 'overview' && <RepoOverview route={route} onNavigate={navigate} />}
            {(route.view === 'history' || route.view === 'transactions') && (
              <HistoryTab route={route} status={data} navigate={navigate} />
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
            {route.view === 'changes' && (
              <RepoChanges
                repo={repo}
                hrefOf={(number) => formatSourceRoute({ view: 'change', repo, number })}
                onOpen={(number) => navigate({ view: 'change', repo, number })}
              />
            )}
            {route.view === 'change' && (
              <ChangeView
                key={route.number}
                repo={repo}
                number={route.number}
                onBack={() => navigate({ view: 'changes', repo })}
                onCommit={(commit) => navigate({ view: 'commit', repo, commit })}
                onChanged={status.reload}
              />
            )}
            {route.view === 'search' && (
              <RepoSearch key={route.query} repo={repo} query={route.query} onNavigate={navigate} />
            )}
            {route.view === 'repo-settings' && (
              <RepoSettings
                repo={repo}
                section={route.section}
                status={data}
                navigate={navigate}
                onPolicySaved={status.reload}
                onDeleted={onDeleted}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
