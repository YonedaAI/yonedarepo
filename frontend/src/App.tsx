import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useGuidedNavigation } from './features/guided-demo/useGuidedNavigation';
import { DeleteRepositoryDialog } from './features/workspace/DeleteRepositoryDialog';
import { RepositoryRecovery } from './features/workspace/RepositoryRecovery';
import { RepositoryWorkspace } from './features/workspace/RepositoryWorkspace';
import { SessionEnded } from './features/workspace/SessionEnded';
import { WorkspaceHeader } from './features/workspace/WorkspaceHeader';
import { type WorkspacePanel, WorkspacePanels } from './features/workspace/WorkspacePanels';
import { WorkspaceRail } from './features/workspace/WorkspaceRail';
import { WorkspaceWelcome } from './features/workspace/WorkspaceWelcome';
import { useRepository } from './hooks/useRepository';
import type { Repository } from './lib/types';

export function App() {
  const state = useRepository();
  const guided = useGuidedNavigation(state.id, state.authenticated);
  const [panel, setPanel] = useState<WorkspacePanel>(null);
  const [deleting, setDeleting] = useState<Repository | null>(null);
  const [notice, setNotice] = useState('');
  const providerReturn = useRef<(() => void) | undefined>(undefined);
  // The guided demo spends operator-funded agents, so only reviewer accounts are offered it.
  const openGuidedDemo =
    state.identity?.role === 'user' && state.identity.reviewer === true
      ? () => setPanel('guided-project')
      : undefined;
  useEffect(() => {
    if (!state.sessionEnded) return;
    setPanel(null);
    setDeleting(null);
  }, [state.sessionEnded]);
  return (
    <div className="app">
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>
      <WorkspaceRail state={state} onPanel={setPanel} />
      <main id="workspace">
        <WorkspaceHeader
          repository={state.snapshot?.repository ?? state.project}
          loading={state.loading}
          onDelete={setDeleting}
          authenticated={state.authenticated}
          identity={state.identity}
          onSignIn={() => {
            // The ended-session view already holds the sign-in form; never stack a second one.
            if (state.sessionEnded)
              document.querySelector<HTMLInputElement>('.session-ended input')?.focus();
            else setPanel('account');
          }}
          onSignOut={async () => {
            await state.signOut();
            setPanel(null);
          }}
          onError={state.setError}
          onRefresh={() => {
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
            {state.error && (
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
            {state.snapshot && (
              <RepositoryRecovery
                repository={state.snapshot.repository}
                onChange={state.refresh}
                onError={state.setError}
              />
            )}
            {state.snapshot ? (
              <RepositoryWorkspace
                key={state.id}
                snapshot={state.snapshot}
                guidedSessionId={guided.session}
                onGuidedSession={guided.remember}
                onGuidedDemo={openGuidedDemo}
                initialRunId={state.requestedRunId}
                requestedRunError={state.requestedRunError}
                onChange={state.refresh}
                onError={state.setError}
                onPanel={setPanel}
                onProviders={(refresh) => {
                  providerReturn.current = refresh;
                  setPanel('providers');
                }}
              />
            ) : (
              <WorkspaceWelcome
                state={state}
                onProject={() => setPanel('project')}
                onGuidedDemo={openGuidedDemo}
                onProviders={() => setPanel('agents')}
              />
            )}
          </>
        )}
      </main>
      <WorkspacePanels
        panel={panel}
        onGuidedCreated={guided.remember}
        state={state}
        onPanel={setPanel}
        onClose={() => {
          setPanel(null);
          const refresh = providerReturn.current;
          providerReturn.current = undefined;
          refresh?.();
        }}
      />
      {deleting && (
        <DeleteRepositoryDialog
          key={deleting.id}
          repository={deleting}
          onClose={() => setDeleting(null)}
          onDelete={state.deleteRepository}
          onDeleted={({ cleanup_pending }) => {
            setDeleting(null);
            setPanel(null);
            setNotice(
              cleanup_pending
                ? 'Repository deleted. Storage cleanup continues in the background.'
                : 'Repository deleted.',
            );
          }}
        />
      )}
    </div>
  );
}
