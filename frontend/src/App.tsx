import { X } from 'lucide-react';
import { useState } from 'react';
import { DeleteRepositoryDialog } from './features/workspace/DeleteRepositoryDialog';
import { RepositoryRecovery } from './features/workspace/RepositoryRecovery';
import { RepositoryWorkspace } from './features/workspace/RepositoryWorkspace';
import { ReviewerTrial } from './features/workspace/ReviewerTrial';
import { WorkspaceHeader } from './features/workspace/WorkspaceHeader';
import { type WorkspacePanel, WorkspacePanels } from './features/workspace/WorkspacePanels';
import { WorkspaceRail } from './features/workspace/WorkspaceRail';
import { WorkspaceWelcome } from './features/workspace/WorkspaceWelcome';
import { useRepository } from './hooks/useRepository';
import type { Repository } from './lib/types';

export function App() {
  const state = useRepository();
  const [panel, setPanel] = useState<WorkspacePanel>(null);
  const [deleting, setDeleting] = useState<Repository | null>(null);
  const [notice, setNotice] = useState('');
  const reviewer = state.identity?.role === 'user' && state.identity.reviewer === true;
  return (
    <div className="app">
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>
      <WorkspaceRail reviewer={reviewer} state={state} onPanel={setPanel} />
      <main id="workspace">
        <WorkspaceHeader
          reviewer={reviewer}
          repository={state.snapshot?.repository ?? state.project}
          loading={state.loading}
          onDelete={setDeleting}
          authenticated={state.authenticated}
          identity={state.identity}
          onSignIn={() => setPanel('account')}
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
        {reviewer && state.snapshot && (
          <ReviewerTrial onChange={state.refresh} onError={state.setError} />
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
            reviewer={reviewer}
            key={state.id}
            snapshot={state.snapshot}
            initialRunId={state.requestedRunId}
            requestedRunError={state.requestedRunError}
            onChange={state.refresh}
            onError={state.setError}
            onPanel={setPanel}
          />
        ) : (
          <WorkspaceWelcome
            reviewer={reviewer}
            state={state}
            onProject={() => setPanel('project')}
            onProviders={() => setPanel('providers')}
          />
        )}
      </main>
      <WorkspacePanels
        reviewer={reviewer}
        panel={panel}
        state={state}
        onClose={() => setPanel(null)}
      />
      {deleting && !reviewer && (
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
