import { X } from 'lucide-react';
import { useState } from 'react';
import { RepositoryWorkspace } from './features/workspace/RepositoryWorkspace';
import { WorkspaceHeader } from './features/workspace/WorkspaceHeader';
import { type WorkspacePanel, WorkspacePanels } from './features/workspace/WorkspacePanels';
import { WorkspaceRail } from './features/workspace/WorkspaceRail';
import { WorkspaceWelcome } from './features/workspace/WorkspaceWelcome';
import { useRepository } from './hooks/useRepository';

export function App() {
  const state = useRepository();
  const [panel, setPanel] = useState<WorkspacePanel>(null);
  return (
    <div className="app">
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>
      <WorkspaceRail state={state} onPanel={setPanel} />
      <main id="workspace">
        <WorkspaceHeader
          repository={state.snapshot?.repository}
          loading={state.loading}
          onRefresh={() => {
            void state.discover();
            void state.refresh();
          }}
        />
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
    </div>
  );
}
