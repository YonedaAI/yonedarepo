// A repository inside the shell: name, status chips and the current page (the sidebar lists
// the pages). A public
// repository opens for anyone; a viewer who reads only because it is public (or is signed
// out) gets the read views, with no write or admin controls.
import { useEffect } from 'react';
import { RepoSettings } from '../repo-settings/RepoSettings';
import { linkTo, type Navigate } from '../shell/useRoute';
import { ChangeView } from './ChangeView';
import { CommitView } from './CommitView';
import { ForkButton } from './ForkButton';
import { HistoryTab } from './HistoryTab';
import { PublicBadge } from './PublicBadge';
import { ShowEmailsContext } from './people';
import { ReleaseView } from './ReleaseView';
import { RepoAgents } from './RepoAgents';
import { RepoChanges } from './RepoChanges';
import { RepoContext } from './RepoContext';
import { RepoFiles } from './RepoFiles';
import { RepoNotFound, repoMissing, useRepoGone } from './RepoNotFound';
import { RepoOverview } from './RepoOverview';
import { RepoReleases } from './RepoReleases';
import { RepoSearch } from './RepoSearch';
import { isPublic, ReadOnlyContext, repoAccess, type Visibility } from './repoAccess';
import type { RepoStatus } from './repoStatus';
import { SessionView } from './SessionView';
import { Failure } from './SourceStatus';
import { StatusChips } from './StatusChips';
import { formatSourceRoute, type SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

type RepoRoute = Extract<SourceRoute, { repo: string }>;

export function RepoPage({
  route,
  name,
  authenticated,
  username,
  navigate,
  onDeleted,
  onMissing,
  onNew,
  onSignIn,
  onLoaded,
}: {
  route: RepoRoute;
  /** The name the sidebar shows, until the repository's own status loads. */
  name?: string;
  /** Whether an account is signed in (a signed-out visitor reads public repositories only). */
  authenticated: boolean;
  /** The signed-in account's username. */
  username?: string;
  navigate: Navigate;
  onDeleted: () => void;
  /** The repository is not there for this viewer (deleted, unknown, private or not theirs). */
  onMissing: () => void;
  onNew: () => void;
  onSignIn?: () => void;
  /** The loaded name and visibility, and whether the viewer may change settings, for the
   * shell's header and sidebar. */
  onLoaded?: (repo: {
    repo: string;
    name: string;
    visibility: Visibility;
    settings: boolean;
  }) => void;
}) {
  const repo = route.repo;
  const status = useSource<RepoStatus>(`/repos/${repo}`);
  const gone = useRepoGone(repo);
  const missing = gone || repoMissing(status.code);
  const data = status.data;
  const access = repoAccess(data?.viewer, authenticated);
  const owner = access.settings;
  const drift = data?.projections?.filter((p) => p.status === 'drift') ?? [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per transition, not per render of the caller.
  useEffect(() => {
    if (missing) onMissing();
  }, [missing]);
  useEffect(() => {
    if (data)
      onLoaded?.({
        repo,
        name: data.name,
        visibility: data.visibility ?? 'private',
        settings: owner,
      });
  }, [data, repo, owner, onLoaded]);
  if (missing)
    return (
      <RepoNotFound
        navigate={navigate}
        onNew={onNew}
        authenticated={authenticated}
        onSignIn={onSignIn}
      />
    );
  return (
    // Members see email-named accounts as they are; anyone reading only because the repository
    // is public sees "member" instead (people.ts).
    <ShowEmailsContext.Provider value={!access.readOnly}>
      <ReadOnlyContext.Provider value={access.readOnly}>
        <div className="repo-page">
          <div className="repo-head">
            <h1>{name ?? data?.name ?? repo}</h1>
            {isPublic(data?.visibility) && <PublicBadge />}
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
            {access.fork && data && (
              <ForkButton
                repo={repo}
                name={data.name}
                onForked={(fork) =>
                  navigate({ view: 'files', repo: fork.id, path: '', ref: 'main' })
                }
              />
            )}
          </div>
          {drift.map((p) => (
            <p key={p.refname} role="alert" className="source-error">
              {p.refname.replace(/^refs\/heads\//, '')} in the Git object store has drifted from the
              landed branch and is no longer updated: {p.detail}
            </p>
          ))}
          {status.error && (
            <Failure error={status.error} what="this repository" onRetry={status.reload} />
          )}
          {!status.error && (
            <div className="repo-view">
              {route.view === 'files' && (
                <RepoFiles route={route} status={data} navigate={navigate} />
              )}
              {route.view === 'overview' && <RepoOverview route={route} onNavigate={navigate} />}
              {(route.view === 'history' ||
                route.view === 'transactions' ||
                route.view === 'branches') && (
                <HistoryTab route={route} status={data} navigate={navigate} />
              )}
              {route.view === 'commit' && (
                <CommitView
                  key={route.commit}
                  repo={repo}
                  commit={route.commit}
                  status={data}
                  username={username}
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
                  navigate={navigate}
                />
              )}
              {route.view === 'agents' && (
                <RepoAgents
                  repo={repo}
                  section={route.section}
                  branches={(data?.refs ?? [])
                    .filter((r) => r.name.startsWith('refs/heads/'))
                    .map((r) => r.name.slice('refs/heads/'.length))}
                  owner={data?.owner}
                  account={username}
                  navigate={navigate}
                />
              )}
              {route.view === 'context' && <RepoContext repo={repo} navigate={navigate} />}
              {route.view === 'session' && (
                <SessionView key={route.id} repo={repo} id={route.id} navigate={navigate} />
              )}
              {route.view === 'releases' && (
                <RepoReleases
                  repo={repo}
                  owner={owner}
                  hrefOf={(tag) => formatSourceRoute({ view: 'release', repo, tag })}
                  onOpen={(tag) => navigate({ view: 'release', repo, tag })}
                />
              )}
              {route.view === 'release' && (
                <ReleaseView
                  key={route.tag}
                  repo={repo}
                  tag={route.tag}
                  owner={owner}
                  onBack={() => navigate({ view: 'releases', repo })}
                  onCommit={(commit) => navigate({ view: 'commit', repo, commit })}
                />
              )}
              {route.view === 'search' && (
                <RepoSearch
                  key={`${route.query}|${route.word === true}`}
                  repo={repo}
                  query={route.query}
                  word={route.word}
                  onNavigate={navigate}
                />
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
          )}
        </div>
      </ReadOnlyContext.Provider>
    </ShowEmailsContext.Provider>
  );
}
