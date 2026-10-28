import { lazy, Suspense } from 'react';
import { Dialog } from '../../components/Dialog';
import type { useRepository } from '../../hooks/useRepository';
import { AgentConnectHelp } from '../source-platform/ConnectPanel';
import { currentApiOrigin } from '../source-platform/connect';
import { AccountPanel } from './AccountPanel';
import { ConnectAgents } from './ConnectAgents';
import { OwnerConnection } from './OwnerConnection';

const ProviderSettings = lazy(() =>
  import('./ProviderSettings').then((module) => ({ default: module.ProviderSettings })),
);

export type WorkspacePanel = 'agents' | 'providers' | 'cli' | 'owner' | 'account' | null;
const titles = {
  agents: 'Connect Agents',
  providers: 'Agent providers',
  cli: 'Connect agents with the CLI and MCP',
  owner: 'Administrator access',
  account: 'Sign in to YonedaRepo',
};

export function WorkspacePanels({
  reviewer = false,
  panel,
  state,
  onClose,
  onNew,
}: {
  reviewer?: boolean;
  panel: WorkspacePanel;
  state: ReturnType<typeof useRepository>;
  onClose: () => void;
  /** Opens "New repository" (Connect Agents offers it before any repository exists). */
  onNew?: () => void;
}) {
  if (!panel || (reviewer && ['agents', 'providers'].includes(panel))) return null;
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
          onProject={onNew}
        />
      )}
      {panel === 'providers' && state.authenticated && (
        <Suspense fallback={<p role="status">Loading connections…</p>}>
          <ProviderSettings onClose={onClose} />
        </Suspense>
      )}
      {panel === 'cli' && (
        <div className="source-connect">
          <AgentConnectHelp origin={currentApiOrigin()} />
        </div>
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
