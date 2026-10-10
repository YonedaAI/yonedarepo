import { lazy, Suspense } from 'react';
import { Dialog } from '../../components/Dialog';
import type { useRepository } from '../../hooks/useRepository';
import { AccountPanel } from './AccountPanel';
import { AgentConnections } from './AgentConnections';
import { DemoGuide } from './DemoGuide';
import { NewProject } from './NewProject';
import { OwnerConnection } from './OwnerConnection';

const ProviderSettings = lazy(() =>
  import('./ProviderSettings').then((module) => ({ default: module.ProviderSettings })),
);

export type WorkspacePanel =
  | 'agents'
  | 'providers'
  | 'project'
  | 'owner'
  | 'guide'
  | 'account'
  | null;
const titles = {
  agents: 'Connect a local agent',
  providers: 'Agent providers',
  project: 'Add repository',
  owner: 'Administrator access',
  guide: 'How YonedaRepo works',
  account: 'Sign in to YonedaRepo',
};

export function WorkspacePanels({
  reviewer = false,
  panel,
  state,
  onClose,
}: {
  reviewer?: boolean;
  panel: WorkspacePanel;
  state: ReturnType<typeof useRepository>;
  onClose: () => void;
}) {
  if (!panel || (reviewer && ['agents', 'providers', 'project'].includes(panel))) return null;
  return (
    <Dialog key={panel} title={titles[panel]} onClose={onClose} wide={panel === 'guide'}>
      {panel === 'account' && !state.authenticated && (
        <AccountPanel
          initialMode="login"
          onConnected={() => {
            onClose();
            void state.discover();
          }}
        />
      )}
      {panel === 'agents' && state.snapshot && (
        <AgentConnections repo={state.id} onClose={onClose} />
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
      {panel === 'guide' && <DemoGuide onClose={onClose} />}
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
