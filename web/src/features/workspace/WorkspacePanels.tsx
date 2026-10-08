import { Dialog } from '../../components/Dialog';
import type { useRepository } from '../../hooks/useRepository';
import { AgentConnections } from './AgentConnections';
import { DemoGuide } from './DemoGuide';
import { NewProject } from './NewProject';
import { OwnerConnection } from './OwnerConnection';
import { ProviderSettings } from './ProviderSettings';

export type WorkspacePanel = 'agents' | 'providers' | 'project' | 'owner' | 'guide' | null;
const titles = {
  agents: 'Connect a local agent',
  providers: 'Agent providers',
  project: 'Add repository',
  owner: 'Administrator access',
  guide: 'How YonedaRepo works',
};

export function WorkspacePanels({
  panel,
  state,
  onClose,
}: {
  panel: WorkspacePanel;
  state: ReturnType<typeof useRepository>;
  onClose: () => void;
}) {
  if (!panel) return null;
  return (
    <Dialog key={panel} title={titles[panel]} onClose={onClose} wide={panel === 'guide'}>
      {panel === 'agents' && state.snapshot && (
        <AgentConnections repo={state.id} onClose={onClose} />
      )}
      {panel === 'providers' && state.authenticated && <ProviderSettings onClose={onClose} />}
      {panel === 'project' && state.authenticated && (
        <NewProject
          onClose={onClose}
          onCreated={async (id) => {
            await state.discover();
            state.setId(id);
            onClose();
          }}
        />
      )}
      {panel === 'guide' && <DemoGuide onClose={onClose} />}
      {panel === 'owner' && (
        <OwnerConnection
          authenticated={state.authenticated}
          onConnected={() => {
            onClose();
            void state.discover();
          }}
          onDisconnect={state.clear}
          onError={state.setError}
        />
      )}
    </Dialog>
  );
}
