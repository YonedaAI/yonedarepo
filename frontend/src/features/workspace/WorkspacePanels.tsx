import { Dialog } from '../../components/Dialog';
import { AgentConnectHelp } from '../source-platform/ConnectPanel';
import { currentApiOrigin } from '../source-platform/connect';
import { AccountPanel } from './AccountPanel';

export type WorkspacePanel = 'cli' | 'account' | null;
const titles = {
  cli: 'Connect agents with the CLI and MCP',
  account: 'Sign in to YonedaRepo',
};

export function WorkspacePanels({
  panel,
  authenticated,
  accountError,
  onSignedIn,
  onClose,
}: {
  panel: WorkspacePanel;
  authenticated: boolean;
  /** Why a provider sign-in came back refused, shown in the sign-in panel. */
  accountError?: string;
  onSignedIn: () => void;
  onClose: () => void;
}) {
  // Signed in, the sign-in panel has nothing to show (a refused provider sign-in may have
  // opened it before the session loaded).
  if (!panel || (panel === 'account' && authenticated)) return null;
  return (
    <Dialog key={panel} title={titles[panel]} onClose={onClose}>
      {panel === 'account' && !authenticated && (
        <AccountPanel
          initialMode="login"
          initialError={accountError}
          onConnected={() => {
            onClose();
            onSignedIn();
          }}
        />
      )}
      {panel === 'cli' && (
        <div className="source-connect">
          <AgentConnectHelp origin={currentApiOrigin()} />
        </div>
      )}
    </Dialog>
  );
}
