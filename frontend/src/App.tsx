// The one app shell: sidebar, header and account menu around every page (home, a
// repository's tabs, account settings and device login).
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AccountSettings } from './features/account-settings/AccountSettings';
import { HomePage } from './features/shell/HomePage';
import { type Created, NewRepositoryDialog } from './features/shell/NewRepositoryDialog';
import { type PlatformRepo, repoRows } from './features/shell/repoRows';
import { useRoute } from './features/shell/useRoute';
import { DevicePage } from './features/source-platform/DevicePage';
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
  const platform = useSource<{ repos: PlatformRepo[] }>(session.authenticated ? '/repos' : null);
  const rows = repoRows(platform.data?.repos ?? []);
  const rowsError = platform.error && !/Sign in/.test(platform.error) ? platform.error : '';
  const repo = routeRepo(route);
  const row = repo ? rows.find((r) => r.repo === repo) : undefined;
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
      : route.view === 'settings'
        ? 'Settings'
        : route.view === 'device'
          ? 'Approve a device'
          : (row?.name ?? repo ?? '');
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
        current={repo}
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
            {route.view === 'settings' && (
              <AccountSettings
                identity={session.identity}
                repos={rows.map((r) => ({ id: r.repo, name: r.name }))}
              />
            )}
            {route.view === 'device' && <DevicePage code={route.code} />}
            {'repo' in route && (
              <RepoPage
                key={`${route.repo}:${tick}`}
                route={route}
                name={row?.name}
                navigate={navigate}
                onDeleted={() => {
                  platform.reload();
                  navigate({ view: 'home' });
                  setNotice('Repository deleted.');
                }}
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
      {creating && <NewRepositoryDialog onClose={() => setCreating(false)} onCreated={created} />}
    </div>
  );
}
