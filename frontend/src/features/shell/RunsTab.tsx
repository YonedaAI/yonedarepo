// The Runs tab and History's agent context, for a repository with an agent project. They
// read the project's snapshot, which the shell selects when such a repository opens.
import { LoaderCircle } from 'lucide-react';
import type { useRepository } from '../../hooks/useRepository';
import type { Repository } from '../../lib/types';
import { RepositoryRecovery } from '../workspace/RepositoryRecovery';
import { AgentSourceHistory, RepositoryWorkspace } from '../workspace/RepositoryWorkspace';
import { SetupProgress } from '../workspace/SetupProgress';
import type { WorkspacePanel } from '../workspace/WorkspacePanels';

type State = ReturnType<typeof useRepository>;

function Opening({ state }: { state: State }) {
  return (
    <p className="workspace-inline-status" aria-live="polite">
      <LoaderCircle size={18} className="spin" aria-hidden="true" />
      {state.error ? state.error : 'Loading runs and recorded context…'}
    </p>
  );
}

export function RunsTab({
  state,
  project,
  run,
  onPanel,
  onProviders,
}: {
  state: State;
  project: Repository;
  /** A run named by the URL (`?run=`). */
  run?: string;
  onPanel: (panel: WorkspacePanel) => void;
  onProviders: (refresh?: () => void) => void;
}) {
  if (['provisioning', 'failed'].includes(project.status))
    return (
      <SetupProgress
        key={project.id}
        project={project}
        error={state.error}
        onRetry={state.retrySetup}
        onRefresh={state.refresh}
      />
    );
  const snapshot = state.snapshot?.repository.id === project.id ? state.snapshot : null;
  if (!snapshot) return <Opening state={state} />;
  return (
    <>
      <RepositoryRecovery
        repository={snapshot.repository}
        decisions={snapshot.decisions}
        onChange={state.refresh}
        onError={state.setError}
      />
      <RepositoryWorkspace
        key={project.id}
        snapshot={snapshot}
        initialRunId={run || state.requestedRunId}
        requestedRunError={state.requestedRunError}
        onChange={state.refresh}
        onError={state.setError}
        onPanel={onPanel}
        onProviders={onProviders}
      />
    </>
  );
}

export function AgentContext({ state, project }: { state: State; project: Repository }) {
  const snapshot = state.snapshot?.repository.id === project.id ? state.snapshot : null;
  if (!snapshot) return <Opening state={state} />;
  return (
    <AgentSourceHistory snapshot={snapshot} onChange={state.refresh} onError={state.setError} />
  );
}
