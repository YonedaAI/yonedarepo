// The one app shell: sidebar, header and account menu around every page (home, Explore, a
// repository's tabs, account settings and device login). A signed-out visitor may open
// Explore and any public repository; nothing there asks them to sign in first.
import { X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AccountSettings } from './features/account-settings/AccountSettings';
import { ExplorePage } from './features/explore/ExplorePage';
import { HomePage } from './features/shell/HomePage';
import { type Created, NewRepositoryDialog } from './features/shell/NewRepositoryDialog';
import { type PlatformRepo, repoRows } from './features/shell/repoRows';
import { useRoute } from './features/shell/useRoute';
import { DevicePage } from './features/source-platform/DevicePage';
import { OrgPage } from './features/source-platform/OrgPage';
import type { OrgSummary } from './features/source-platform/orgModel';
import { RepoPage } from './features/source-platform/RepoPage';
import { routeRepo } from './features/source-platform/sourceRoute';
import { useSource } from './features/source-platform/useSource';
import { SessionEnded } from './features/workspace/SessionEnded';
import { WorkspaceHeader } from './features/workspace/WorkspaceHeader';
import { type WorkspacePanel, WorkspacePanels } from './features/workspace/WorkspacePanels';
import { WorkspaceRail } from './features/workspace/WorkspaceRail';
import { useSession } from './hooks/useSession';

export function App() {
  const session = useSession();
  const [route, navigate] = useRoute();
  const [panel, setPanel] = useState<WorkspacePanel>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const [tick, setTick] = useState(0);
  // The open repository's name as its status gives it: another account's public repository
  // is in no sidebar row. (Its Public badge is beside the page heading, not repeated here.)
  const [shown, setShown] = useState<{ repo: string; name: string }>();
  const onLoaded = useCallback(
    (loaded: { repo: string; name: string }) => setShown({ repo: loaded.repo, name: loaded.name }),
    [],
  );
  const [missing, setMissing] = useState<string>();
  const platform = useSource<{ repos: PlatformRepo[] }>(session.authenticated ? '/repos' : null);
  const orgs = useSource<{ orgs: OrgSummary[] }>(session.authenticated ? '/orgs' : null);
  const rows = repoRows(platform.data?.repos ?? []);
  const rowsError = platform.error && !/Sign in/.test(platform.error) ? platform.error : '';
  const repo = routeRepo(route);
  const row = repo ? rows.find((r) => r.repo === repo) : undefined;
  const loaded = shown && shown.repo === repo ? shown : undefined;
  useEffect(() => {
    if (!session.sessionEnded) return;
    setPanel(null);
    setCreating(false);
  }, [session.sessionEnded]);

  async function created(result: Created) {
    platform.reload();
    navigate({ view: 'files', repo: result.repo, path: '', ref: 'main' });
    setCreating(false);
  }
  const title =
    route.view === 'home'
      ? 'All repositories'
      : route.view === 'explore'
        ? 'Explore'
        : route.view === 'settings'
          ? 'Settings'
          : route.view === 'device'
            ? 'Approve a device'
            : route.view === 'org'
              ? route.org
              : repo && repo === missing
                ? 'Repository not found'
                : (row?.name ?? loaded?.name ?? repo ?? '');
  return (
    <div className="app">
      <a className="skip-link" href="#workspace">
        Skip to content
      </a>
      <WorkspaceRail
        authenticated={session.authenticated}
        loading={session.loading || platform.loading}
        rows={rows}
        rowsError={rowsError}
        orgs={orgs.data?.orgs ?? []}
        current={repo}
        currentOrg={route.view === 'org' ? route.org : undefined}
        exploring={route.view === 'explore'}
        navigate={navigate}
        onNew={() => setCreating(true)}
      />
      <main id="workspace">
        <WorkspaceHeader
          title={title}
          loading={session.loading || platform.loading}
          authenticated={session.authenticated}
          identity={session.identity}
          navigate={navigate}
          onConnect={() => setPanel('cli')}
          onSignIn={() => {
            // The ended-session view already holds the sign-in form; never stack a second one.
            if (session.sessionEnded)
              document.querySelector<HTMLInputElement>('.session-ended input')?.focus();
            else setPanel('account');
          }}
          onSignOut={async () => {
            await session.signOut();
            setPanel(null);
            navigate({ view: 'home' });
          }}
          onError={session.setError}
          onRefresh={() => {
            setTick((t) => t + 1);
            platform.reload();
            orgs.reload();
            void session.discover();
          }}
        />
        {session.sessionEnded ? (
          <SessionEnded onConnected={() => void session.discover()} />
        ) : (
          <>
            {notice && (
              <div role="status" className="workspace-notice">
                <span>{notice}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Dismiss notification"
                  onClick={() => setNotice('')}
                >
                  <X size={17} />
                </button>
              </div>
            )}
            {route.view === 'home' && (
              <HomePage
                session={session}
                rows={rows}
                rowsLoading={platform.loading}
                rowsError={rowsError}
                onRetry={() => {
                  platform.reload();
                  void session.discover();
                }}
                navigate={navigate}
                onNew={() => setCreating(true)}
              />
            )}
            {route.view === 'explore' && (
              <ExplorePage authenticated={session.authenticated} navigate={navigate} />
            )}
            {route.view === 'settings' && (
              <AccountSettings
                identity={session.identity}
                repos={rows.map((r) => ({ id: r.repo, name: r.name }))}
                orgs={orgs}
                navigate={navigate}
              />
            )}
            {route.view === 'device' && <DevicePage code={route.code} />}
            {route.view === 'org' && (
              <OrgPage
                key={`${route.org}:${tick}`}
                org={route.org}
                navigate={navigate}
                onDeleted={() => {
                  orgs.reload();
                  navigate({ view: 'settings' });
                  setNotice('Organization deleted.');
                }}
              />
            )}
            {'repo' in route && (
              <RepoPage
                // A sign-in or sign-out changes who is asking: read the status again.
                key={`${route.repo}:${tick}:${session.identity?.username ?? ''}`}
                route={route}
                name={row?.name}
                authenticated={session.authenticated}
                username={session.identity?.username}
                navigate={navigate}
                onSignIn={() => setPanel('account')}
                onLoaded={onLoaded}
                onDeleted={() => {
                  platform.reload();
                  navigate({ view: 'home' });
                  setNotice('Repository deleted.');
                }}
                onMissing={() => {
                  // A stale sidebar entry (deleted elsewhere) drops out with the refreshed list.
                  setMissing(route.repo);
                  platform.reload();
                }}
                onNew={() => setCreating(true)}
              />
            )}
          </>
        )}
      </main>
      <WorkspacePanels
        panel={panel}
        authenticated={session.authenticated}
        onSignedIn={() => void session.discover()}
        onClose={() => setPanel(null)}
      />
      {creating && (
        <NewRepositoryDialog
          account={session.identity?.username}
          orgs={orgs.data?.orgs ?? []}
          initialOwner={route.view === 'org' ? route.org : undefined}
          onClose={() => setCreating(false)}
          onCreated={created}
        />
      )}
    </div>
  );
}
