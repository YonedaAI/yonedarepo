// A repository inside the shell: the current page (the sidebar lists the pages, and the top bar's
// trail names it). A public
// repository opens for anyone; a viewer who reads only because it is public (or is signed
// out) gets the read views, with no write or admin controls.
import { useEffect, useRef } from 'react';
import { RepoSettings } from '../repo-settings/RepoSettings';
import { type Navigate, showAddress } from '../shell/useRoute';
import { ChangeView } from './ChangeView';
import { CommitView } from './CommitView';
import { HistoryTab } from './HistoryTab';
import { ImportStatus } from './ImportStatus';
import { RepoHoldBanner } from './LegalHold';
import { preloadOverviewMarkdown } from './markdownLoader';
import { type OverviewStatus, overviewStatusPath } from './overviewBootstrap';
import { ShowEmailsContext } from './people';
import { ReleaseView } from './ReleaseView';
import { RepoAgents } from './RepoAgents';
import { RepoChanges } from './RepoChanges';
import { RepoContext } from './RepoContext';
import { RepoCtc } from './RepoCtc';
import { RepoFacts } from './RepoFacts';
import { RepoFiles } from './RepoFiles';
import { RepoInsights } from './RepoInsights';
import { RepoNotFound, repoMissing, useRepoGone } from './RepoNotFound';
import { RepoOverview } from './RepoOverview';
import { RepoReleases } from './RepoReleases';
import { RepoSearch } from './RepoSearch';
import { ReadOnlyContext, repoAccess, type Visibility } from './repoAccess';
import { chosenBranch } from './repoBranch';
import { rememberRepoName, repoNameOf } from './repoNames';
import { SessionView } from './SessionView';
import { Failure, Loading } from './SourceStatus';
import { formatSourceRoute, type SourceRoute } from './sourceRoute';
import { useImportProgress } from './useImportProgress';
import { useSource } from './useSource';

type RepoRoute = Extract<SourceRoute, { repo: string }>;

/** What the shell keeps of the open repository. */
export type ShownRepo = { repo: string; name: string; settings: boolean; insights: boolean };

export function RepoPage({
  route,
  name,
  authenticated,
  username,
  navigate,
  onDeleted,
  onMissing,
  onSignIn,
  onLoaded,
  initialStatus,
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
  onSignIn?: () => void;
  /** The loaded name and visibility, and whether the viewer may change settings, for the
   * shell's header and sidebar. */
  onLoaded?: (repo: ShownRepo & { visibility: Visibility }) => void;
  /** The fresh response from this exact named-route navigation, never a stored cache. */
  initialStatus?: OverviewStatus;
}) {
  const preloadsMarkdown = route.view === 'overview';
  useEffect(() => {
    if (preloadsMarkdown) preloadOverviewMarkdown();
  }, [preloadsMarkdown]);
  const repo = route.repo;
  // Named navigation already has a full response; picker mounts keep the fast header path.
  const bootstrap = useRef(initialStatus?.overview !== undefined).current;
  const refName = route.view === 'overview' ? (route.ref ?? chosenBranch(repo)) : undefined;
  const status = useSource<OverviewStatus>(
    !bootstrap || refName === undefined
      ? `/repos/${repo}?summary=true`
      : overviewStatusPath(repo, refName),
    undefined,
    initialStatus,
  );
  // Its readable address (`/<handle>/<name>`): the status names the owner's handle (null
  // while an email-named owner has none: the id address keeps working).
  if (status.data) rememberRepoName(repo, status.data.owner_handle, status.data.name);
  const handle = repoNameOf(repo)?.owner;
  useEffect(() => {
    if (handle) showAddress(route);
  }, [handle, route]);
  const gone = useRepoGone(repo);
  const missing = gone || repoMissing(status.code);
  const data = status.data;
  const access = repoAccess(data?.viewer, authenticated);
  const owner = access.settings;
  const progress = useImportProgress(repo, data?.refs, status.reload);
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
        insights: data.insights === true,
      });
  }, [data, repo, owner, onLoaded]);
  if (missing)
    return <RepoNotFound navigate={navigate} authenticated={authenticated} onSignIn={onSignIn} />;
  return (
    // Members see email-named accounts as they are; anyone reading only because the repository
    // is public sees "member" instead (people.ts).
    <ShowEmailsContext.Provider value={!access.readOnly}>
      <ReadOnlyContext.Provider value={access.readOnly}>
        <div className="repo-page">
          {/* The top bar's trail is what a sighted reader goes by; a screen reader gets the same. */}
          <h1 className="sr-only">{name ?? data?.name ?? repoNameOf(repo)?.name ?? repo}</h1>
          {!data && !status.error && <Loading what="repository" />}
          {data && <RepoHoldBanner repo={repo} />}
          {status.error && (
            <Failure error={status.error} what="this repository" onRetry={status.reload} />
          )}
          {/* Settings stay open: deleting the repository is how a failed import is tried again. */}
          {!status.error && progress.phase !== 'none' && route.view !== 'repo-settings' && (
            <ImportStatus repo={repo} progress={progress} owner={owner} navigate={navigate} />
          )}
          {!status.error && (progress.phase === 'none' || route.view === 'repo-settings') && (
            <div className="repo-view">
              {route.view === 'overview' && data && (
                <RepoOverview
                  repo={repo}
                  refName={route.ref ?? chosenBranch(repo)}
                  status={data}
                  bootstrap={data.overview?.ref === refName ? data.overview : undefined}
                  waiting={!!data.overview && data.overview.ref !== refName}
                  onRetry={status.reload}
                  facts={
                    <RepoFacts
                      repo={repo}
                      status={data}
                      owner={owner}
                      readOnly={access.readOnly}
                      canFork={access.fork}
                      navigate={navigate}
                    />
                  }
                  navigate={navigate}
                  account={username}
                />
              )}
              {route.view === 'files' && (
                <RepoFiles route={route} status={data} navigate={navigate} account={username} />
              )}
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
                  commitHrefOf={(commit) => formatSourceRoute({ view: 'commit', repo, commit })}
                  onCommit={(commit) => navigate({ view: 'commit', repo, commit })}
                  navigate={navigate}
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
              {route.view === 'tower' && (
                <RepoCtc
                  repo={repo}
                  hrefOf={(number) => formatSourceRoute({ view: 'change', repo, number })}
                  onOpen={(number) => navigate({ view: 'change', repo, number })}
                />
              )}
              {route.view === 'insights' && <RepoInsights repo={repo} />}
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
                  navigate={navigate}
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
