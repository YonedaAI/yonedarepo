// What the ⋮ menu's actions do, shared by the overview cards and an agent's page: Pause and
// Resume (repositories and settings kept), Run now (open changes at their heads), Configure,
// Create your own (the New agent page) and Archive (confirmed: off everywhere, setup forgotten).
import { useState } from 'react';
import type { AgentState, AgentUpdate, RunNowResult } from '../../../../shared/managed-agents';
import { Dialog } from '../../components/Dialog';
import type { Navigate } from '../shell/useRoute';
import { Failure } from '../source-platform/SourceStatus';
import { managedApi } from '../source-platform/sourceApi';
import { agentPath, archivePath, type MenuAction, runNowPath, runNowText } from './agentsModel';

type Space = { workspace?: string };

export function useAgentActions(
  workspace: string,
  space: Space,
  navigate: Navigate,
  onChanged: () => void,
) {
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [archiving, setArchiving] = useState<AgentState | null>(null);

  /** Runs one action; answers whether it succeeded. */
  async function call(agent: AgentState, run: () => Promise<string | undefined>) {
    setBusy(agent.id);
    setError('');
    setMessage('');
    try {
      const said = await run();
      if (said) setMessage(said);
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy('');
    }
  }

  function act(agent: AgentState, action: MenuAction) {
    if (action === 'configure')
      return navigate({ view: 'agent-configure', agent: agent.id, ...space });
    if (action === 'create-own')
      return navigate({ view: 'agent-settings', agent: 'new', ...space });
    if (action === 'archive') return setArchiving(agent);
    if (action === 'run')
      return call(agent, async () =>
        runNowText(
          await managedApi<RunNowResult>(runNowPath(workspace, agent.id), {
            method: 'POST',
            body: {},
          }),
        ),
      );
    const body: AgentUpdate = { active: action === 'resume' };
    return call(agent, async () => {
      await managedApi(agentPath(workspace, agent.id), { method: 'PUT', body });
      return action === 'resume'
        ? `${agent.settings.name} is running again.`
        : `${agent.settings.name} is paused.`;
    });
  }

  const dialog = archiving && (
    <Dialog
      title={`Archive ${archiving.settings.name}?`}
      onClose={() => setArchiving(null)}
      locked={busy === archiving.id}
    >
      <p>
        It stops on every repository and its setup is forgotten. Past runs stay listed. You can add
        it again later.
      </p>
      <div className="agent-dialog-actions">
        <button
          type="button"
          className="danger"
          disabled={busy === archiving.id}
          onClick={async () => {
            const agent = archiving;
            const done = await call(agent, async () => {
              await managedApi(archivePath(workspace, agent.id), { method: 'POST', body: {} });
              return `${agent.settings.name} is archived.`;
            });
            setArchiving(null);
            if (done) navigate({ view: 'agents-home', ...space });
          }}
        >
          {busy === archiving.id ? 'Archiving…' : 'Archive'}
        </button>
        <button type="button" className="quiet" onClick={() => setArchiving(null)}>
          Cancel
        </button>
      </div>
    </Dialog>
  );

  const notices = (
    <>
      {message && (
        <p role="status" className="source-meta agent-notice">
          {message}
        </p>
      )}
      {error && <Failure error={error} />}
    </>
  );
  return { act, busy, dialog, notices };
}
