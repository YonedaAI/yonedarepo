import { X } from 'lucide-react';
import { useState } from 'react';
import { DeleteRepositoryDialog } from './features/workspace/DeleteRepositoryDialog';
import { RepositoryWorkspace } from './features/workspace/RepositoryWorkspace';
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
        {state.snapshot ? (
          <RepositoryWorkspace
            key={state.id}
            snapshot={state.snapshot}
            onChange={state.refresh}
            onError={state.setError}
            onPanel={setPanel}
          />
        ) : (
          <WorkspaceWelcome
            state={state}
            onProject={() => setPanel('project')}
            onProviders={() => setPanel('providers')}
          />
        )}
      </main>
      <WorkspacePanels panel={panel} state={state} onClose={() => setPanel(null)} />
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
