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
  onSignedIn,
  onClose,
}: {
  panel: WorkspacePanel;
  authenticated: boolean;
  onSignedIn: () => void;
  onClose: () => void;
}) {
  if (!panel) return null;
  return (
    <Dialog key={panel} title={titles[panel]} onClose={onClose}>
      {panel === 'account' && !authenticated && (
        <AccountPanel
          initialMode="login"
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
