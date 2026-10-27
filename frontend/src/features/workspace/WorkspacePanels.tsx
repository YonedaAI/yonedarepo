import { lazy, Suspense } from 'react';
import { Dialog } from '../../components/Dialog';
import type { useRepository } from '../../hooks/useRepository';
import { AccountPanel } from './AccountPanel';
import { ConnectAgents } from './ConnectAgents';
import { NewProject } from './NewProject';
import { OwnerConnection } from './OwnerConnection';

const ProviderSettings = lazy(() =>
  import('./ProviderSettings').then((module) => ({ default: module.ProviderSettings })),
);

export type WorkspacePanel = 'agents' | 'providers' | 'project' | 'owner' | 'account' | null;
const titles = {
  agents: 'Connect Agents',
  providers: 'Agent providers',
  project: 'Add repository',
  owner: 'Administrator access',
  account: 'Sign in to YonedaRepo',
};

export function WorkspacePanels({
  reviewer = false,
  panel,
  state,
  onClose,
  onPanel,
}: {
  reviewer?: boolean;
  panel: WorkspacePanel;
  state: ReturnType<typeof useRepository>;
  onClose: () => void;
  onPanel?: (panel: WorkspacePanel) => void;
}) {
  if (!panel || (reviewer && ['agents', 'providers', 'project'].includes(panel))) return null;
  return (
    <Dialog key={panel} title={titles[panel]} onClose={onClose}>
      {panel === 'account' && !state.authenticated && (
        <AccountPanel
          initialMode="login"
          onConnected={() => {
            onClose();
            void state.discover();
          }}
        />
      )}
      {panel === 'agents' && state.authenticated && (
        <ConnectAgents
          repo={state.snapshot ? state.id : undefined}
          onClose={onClose}
          onProject={onPanel ? () => onPanel('project') : undefined}
        />
      )}
      {panel === 'providers' && state.authenticated && (
        <Suspense fallback={<p role="status">Loading connections…</p>}>
          <ProviderSettings onClose={onClose} />
        </Suspense>
      )}
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
      {panel === 'owner' && (
        <OwnerConnection
          authenticated={state.identity?.role === 'admin'}
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
