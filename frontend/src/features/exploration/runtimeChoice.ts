import { runsInSandbox } from '../../../../shared/providers';
import type { Snapshot } from '../../lib/types';
import type { Provider } from '../workspace/ProviderSettings';
import type { AdaptiveAgentDraft } from './adaptiveDraft';
import { SANDBOX_RUNTIME } from './sandboxActivityView';

/**
 * Agents work only in sandboxes. A run can start where the Worker advertises the sandbox with
 * the snapshot, and only with models a sandbox CLI can run (Auto picks one). Presentation
 * only: the Worker and ledger refuse anything else.
 */
export function runtimeChoice(
  snapshot: Snapshot,
  agents: AdaptiveAgentDraft[],
  providers: Provider[],
) {
  const offered = snapshot.capabilities?.sandbox_runtime === SANDBOX_RUNTIME;
  const unsupported = agents
    .map((agent) => providers.find((provider) => provider.id === agent.connection))
    .find((connection) => connection && !runsInSandbox(connection.provider));
  const blocker = !offered
    ? 'Runs need sandboxes, and this deployment has none.'
    : unsupported
      ? `${unsupported.label} can't run in the sandbox: no sandbox CLI supports its API.`
      : undefined;
  const sandbox = !blocker;
  // A sandbox run is independent compare attempts (1–6) the owner chooses among, or a team on
  // the owner's task plan whose members land on one team branch.
  return { blocker, sandbox, request: { runtime: SANDBOX_RUNTIME } };
}
