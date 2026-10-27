import { runsInSandbox } from '../../../../shared/providers';
import type { Snapshot } from '../../lib/types';
import type { Provider } from '../workspace/ProviderSettings';
import type { AdaptiveAgentDraft } from './adaptiveDraft';
import { SANDBOX_RUNTIME } from './sandboxActivityView';

export type RunRuntime = 'sandbox' | 'classic';

/**
 * Where a new run's agents work. The sandbox is offered only where the Worker advertises it
 * with the snapshot, and only for models a sandbox CLI can run (Auto picks one); otherwise
 * the run is Classic. Presentation only: the Worker and ledger refuse anything else.
 */
export function runtimeChoice(
  snapshot: Snapshot,
  preferred: RunRuntime,
  agents: AdaptiveAgentDraft[],
  providers: Provider[],
) {
  const offered = snapshot.capabilities?.sandbox_runtime === SANDBOX_RUNTIME;
  const unsupported = agents
    .map((agent) => providers.find((provider) => provider.id === agent.connection))
    .find((connection) => connection && !runsInSandbox(connection.provider));
  const blocker = unsupported
    ? `${unsupported.label} can't run in the sandbox: no sandbox CLI supports its API.`
    : undefined;
  const sandbox = offered && preferred === 'sandbox' && !blocker;
  // A sandbox run is independent compare attempts (1–6) the owner chooses among, no reviewer,
  // or a team on the owner's task plan whose members land on one team branch.
  return { offered, blocker, sandbox, request: sandbox ? { runtime: SANDBOX_RUNTIME } : undefined };
}

export function RunRuntimePicker({
  sandbox,
  blocker,
  locked,
  onChange,
}: {
  sandbox: boolean;
  blocker?: string;
  locked: boolean;
  onChange: (value: RunRuntime) => void;
}) {
  return (
    <fieldset className="run-mode-picker">
      <legend>Where should agents work?</legend>
      <label>
        <input
          type="radio"
          name="run-runtime"
          value="sandbox"
          checked={sandbox}
          disabled={locked || !!blocker}
          onChange={() => onChange('sandbox')}
        />
        <span>
          <strong>Sandbox (stock coding CLIs)</strong>
          <small>
            Each agent runs Claude Code, Codex CLI, opencode or MiMo Code in its own sandbox and
            branch. You choose what to publish.
          </small>
        </span>
      </label>
      <label>
        <input
          type="radio"
          name="run-runtime"
          value="classic"
          checked={!sandbox}
          disabled={locked}
          onChange={() => onChange('classic')}
        />
        <span>
          <strong>Classic</strong>
          <small>Hosted agents, with team runs and automatic review.</small>
        </span>
      </label>
      {blocker && <p className="subtle">{blocker}</p>}
    </fieldset>
  );
}
