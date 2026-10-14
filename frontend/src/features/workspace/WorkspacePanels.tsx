import { lazy, Suspense } from 'react';
import { Dialog } from '../../components/Dialog';
import type { useRepository } from '../../hooks/useRepository';
import { GuidedProject } from '../guided-demo/GuidedProject';
import { AccountPanel } from './AccountPanel';
import { ConnectAgents } from './ConnectAgents';
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
  | 'guided-project'
  | 'owner'
  | 'guide'
  | 'account'
  | null;
const titles = {
  agents: 'Connect Agents',
  providers: 'Agent providers',
  project: 'Add repository',
  'guided-project': 'Try guided demo',
  owner: 'Administrator access',
  guide: 'How YonedaRepo works',
  account: 'Sign in to YonedaRepo',
};

export function WorkspacePanels({
  reviewer = false,
  panel,
  state,
  onClose,
  onPanel,
  onGuidedCreated,
}: {
  reviewer?: boolean;
  panel: WorkspacePanel;
  state: ReturnType<typeof useRepository>;
  onClose: () => void;
  onGuidedCreated?: (repo: string, session?: string) => void;
  onPanel?: (panel: WorkspacePanel) => void;
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
      {panel === 'guided-project' && state.authenticated && (
        <GuidedProject
          onClose={onClose}
          onCreated={async (id, session) => {
            await state.discover();
            onGuidedCreated?.(id, session);
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
