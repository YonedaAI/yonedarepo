// The one app shell: sidebar, header and account menu around every page (home, a
// repository's tabs, account settings and device login).
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AccountSettings } from './features/account-settings/AccountSettings';
import { HomePage } from './features/shell/HomePage';
import { type Created, NewRepositoryDialog } from './features/shell/NewRepositoryDialog';
import { AgentContext, RunsTab } from './features/shell/RunsTab';
import { type PlatformRepo, projectRepo, repoRows } from './features/shell/repoRows';
import { useRoute } from './features/shell/useRoute';
import { DevicePage } from './features/source-platform/DevicePage';
import { RepoPage } from './features/source-platform/RepoPage';
import { routeRepo } from './features/source-platform/sourceRoute';
import { useSource } from './features/source-platform/useSource';
import { DeleteRepositoryDialog } from './features/workspace/DeleteRepositoryDialog';
import { SessionEnded } from './features/workspace/SessionEnded';
import { WorkspaceHeader } from './features/workspace/WorkspaceHeader';
import { type WorkspacePanel, WorkspacePanels } from './features/workspace/WorkspacePanels';
import { WorkspaceRail } from './features/workspace/WorkspaceRail';
import { useRepository } from './hooks/useRepository';
import type { Repository } from './lib/types';

export function App() {
  const state = useRepository();
  const [route, navigate] = useRoute();
  const [panel, setPanel] = useState<WorkspacePanel>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Repository | null>(null);
  const [notice, setNotice] = useState('');
  const [tick, setTick] = useState(0);
  const providerReturn = useRef<(() => void) | undefined>(undefined);
  const platform = useSource<{ repos: PlatformRepo[] }>(state.authenticated ? '/repos' : null);
  const rows = repoRows(platform.data?.repos ?? [], state.repositories);
  const repo = routeRepo(route);
  const row = repo ? rows.find((r) => r.repo === repo) : undefined;
  const project = row?.project;
  const linked =
    route.view === 'home' && route.project
      ? state.repositories.find((p) => p.id === route.project)
      : undefined;
  const linkedRepo = linked && projectRepo(linked);
  const selectId = project?.id ?? linked?.id;
  const { setId } = state;
  // The Runs tab reads the selected project's snapshot.
  useEffect(() => {
    if (selectId && selectId !== state.id) setId(selectId);
  }, [selectId, state.id, setId]);
  // The workspace's older `/?repo=<project>&run=` link opens that project's Runs tab.
  useEffect(() => {
    if (linkedRepo)
      navigate(
        {
          view: 'runs',
          repo: linkedRepo,
          ...(state.requestedRunId ? { run: state.requestedRunId } : {}),
        },
        { replace: true },
      );
  }, [linkedRepo, navigate, state.requestedRunId]);
  useEffect(() => {
    if (!state.sessionEnded) return;
    setPanel(null);
    setDeleting(null);
    setCreating(false);
  }, [state.sessionEnded]);

  async function created(result: Created) {
    platform.reload();
    if ('repo' in result) navigate({ view: 'files', repo: result.repo, path: '', ref: 'main' });
    else {
      await state.discover();
      state.setId(result.project);
      navigate({ view: 'home', project: result.project });
    }
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
  const agentErrors = route.view === 'home' || route.view === 'runs';
  return (
    <div className="app">
      <a className="skip-link" href="#workspace">
        Skip to content
      </a>
      <WorkspaceRail
        state={state}
        rows={rows}
        rowsError={platform.error && !/Sign in/.test(platform.error) ? platform.error : ''}
        current={row?.key ?? (linked ? `project:${linked.id}` : undefined)}
        navigate={navigate}
        onNew={() => setCreating(true)}
        onPanel={setPanel}
      />
      <main id="workspace">
        <WorkspaceHeader
          title={title}
          project={project}
          loading={state.loading || platform.loading}
          authenticated={state.authenticated}
          identity={state.identity}
          navigate={navigate}
          onConnect={() => setPanel('cli')}
          onSignIn={() => {
            // The ended-session view already holds the sign-in form; never stack a second one.
            if (state.sessionEnded)
              document.querySelector<HTMLInputElement>('.session-ended input')?.focus();
            else setPanel('account');
          }}
          onSignOut={async () => {
            await state.signOut();
            setPanel(null);
            navigate({ view: 'home' });
          }}
          onError={state.setError}
          onRefresh={() => {
            setTick((t) => t + 1);
            platform.reload();
            void state.discover();
            void state.refresh();
          }}
        />
        {state.sessionEnded ? (
          <SessionEnded onConnected={() => void state.discover()} />
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
            {agentErrors && state.error && (
              <div role="alert" className="error-banner">
                <span>{state.error}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={() => state.setError('')}
                >
                  <X size={17} />
                </button>
              </div>
            )}
            {route.view === 'home' && (
              <HomePage
                state={state}
                rows={rows}
                setupProject={!!linked && !linkedRepo}
                navigate={navigate}
                onNew={() => setCreating(true)}
                onProviders={() => setPanel('agents')}
              />
            )}
            {route.view === 'settings' && (
              <AccountSettings
                identity={state.identity}
                repos={rows.flatMap((r) => (r.repo ? [{ id: r.repo, name: r.name }] : []))}
              />
            )}
            {route.view === 'device' && <DevicePage code={route.code} />}
            {'repo' in route && (
              <RepoPage
                key={route.view === 'runs' ? route.repo : `${route.repo}:${tick}`}
                route={route}
                name={row?.name}
                project={project}
                navigate={navigate}
                runs={
                  project && (
                    <RunsTab
                      state={state}
                      project={project}
                      run={route.view === 'runs' ? route.run : undefined}
                      onPanel={setPanel}
                      onProviders={(refresh) => {
                        providerReturn.current = refresh;
                        setPanel('providers');
                      }}
                    />
                  )
                }
                agentContext={project && <AgentContext state={state} project={project} />}
                onDeleted={() => {
                  platform.reload();
                  navigate({ view: 'home' });
                  setNotice('Repository deleted.');
                }}
                onDeleteProject={setDeleting}
              />
            )}
          </>
        )}
      </main>
      <WorkspacePanels
        panel={panel}
        state={state}
        onNew={() => {
          setPanel(null);
          setCreating(true);
        }}
        onClose={() => {
          setPanel(null);
          const refresh = providerReturn.current;
          providerReturn.current = undefined;
          refresh?.();
        }}
      />
      {creating && <NewRepositoryDialog onClose={() => setCreating(false)} onCreated={created} />}
      {deleting && (
        <DeleteRepositoryDialog
          key={deleting.id}
          repository={deleting}
          onClose={() => setDeleting(null)}
          onDelete={state.deleteRepository}
          onDeleted={({ cleanup_pending }) => {
            setDeleting(null);
            setPanel(null);
            platform.reload();
            setNotice(
              cleanup_pending
                ? 'Agent project removed; cleanup continues in the background. The repository stays until you delete it.'
                : 'Agent project removed. The repository stays until you delete it.',
            );
          }}
        />
      )}
    </div>
  );
}
