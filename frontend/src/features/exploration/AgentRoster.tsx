import { defaultSandboxCli, sandboxCliNames, sandboxClis } from '../../../../shared/providers';
import type { AgentLimits } from '../../lib/types';
import type { Provider } from '../workspace/ProviderSettings';
import {
  connectedModelGroups,
  modelDisplayName,
  modelReasoningEfforts,
  reasoningLabel,
} from '../workspace/providerModels';
import {
  type AdaptiveAgentDraft,
  agentRoles,
  automaticAgent,
  reasoningIssue,
} from './adaptiveDraft';
import { agentConnectionIssue } from './restartRun';

export function AgentRoster({
  agents,
  providers,
  loading,
  error,
  limits,
  locked,
  onChange,
  onProviders,
  onRetry,
  compare = false,
  sandbox = false,
}: {
  agents: AdaptiveAgentDraft[];
  providers: Provider[];
  loading: boolean;
  error: string;
  limits: AgentLimits;
  locked: boolean;
  onChange: (agents: AdaptiveAgentDraft[]) => void;
  onProviders: () => void;
  onRetry: () => void;
  team?: boolean;
  compare?: boolean;
  /** A sandbox run: each agent with a chosen model also picks the stock CLI it runs. */
  sandbox?: boolean;
}) {
  function update(id: string, patch: Partial<AdaptiveAgentDraft>) {
    onChange(agents.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent)));
  }
  return (
    <section className="agent-roster simple-agent-roster" aria-labelledby="agent-roster-heading">
      <div className="section-heading">
        <h3 id="agent-roster-heading">{compare ? 'Builders' : 'Agents'}</h3>
        {!compare && (
          <button
            type="button"
            className="quiet"
            disabled={locked || agents.length >= limits.max_root_agents}
            onClick={() => onChange([...agents, automaticAgent()])}
          >
            Add agent
          </button>
        )}
      </div>
      {agents.map((agent, index) => {
        const issue =
          !loading && agent.connection ? agentConnectionIssue(agent, providers) : undefined;
        const unavailable =
          !!agent.connection && !providers.some((provider) => provider.id === agent.connection);
        const connection = providers.find((provider) => provider.id === agent.connection);
        const efforts = connection
          ? modelReasoningEfforts(connection.provider, connection.model)
          : [];
        const effortIssue = reasoningIssue(agent, providers);
        const clis = sandbox && connection ? sandboxClis(connection.provider) : [];
        const cli =
          agent.cli && clis.includes(agent.cli)
            ? agent.cli
            : connection && defaultSandboxCli(connection.provider);
        return (
          <fieldset
            className={`agent-inputs seed-agent${efforts.length > 0 || agent.reasoning_effort != null ? ' has-reasoning' : ''}`}
            key={agent.id}
          >
            <legend>
              {compare ? 'Builder' : 'Agent'} {index + 1}
            </legend>
            <label>
              Model
              <select
                aria-label={`Model for agent ${index + 1}`}
                disabled={locked}
                value={agent.connection}
                onChange={(event) =>
                  update(agent.id, {
                    connection: event.target.value,
                    expectedProvider: undefined,
                    expectedModel: undefined,
                    fromPreviousRun: false,
                    reasoning_effort: undefined,
                    cli: undefined,
                  })
                }
              >
                <option value="">Auto</option>
                {unavailable && (
                  <option value={agent.connection} disabled>
                    Previous connection (unavailable)
                  </option>
                )}
                {connectedModelGroups(providers, agent.connection).map((group) => (
                  <optgroup key={group.provider} label={group.label}>
                    {group.options.map(({ connection, label, disabled }) => (
                      <option key={connection.id} value={connection.id} disabled={disabled}>
                        {label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            {(efforts.length > 0 || agent.reasoning_effort != null) && (
              <label>
                Reasoning
                <select
                  aria-label={`Reasoning for agent ${index + 1}`}
                  disabled={locked}
                  value={agent.reasoning_effort ?? ''}
                  onChange={(event) => {
                    const effort = event.target.value;
                    if (!effort || efforts.includes(effort))
                      update(agent.id, { reasoning_effort: effort || undefined });
                  }}
                >
                  <option value="">Auto</option>
                  {effortIssue && (
                    <option value={agent.reasoning_effort} disabled>
                      Previous setting (unavailable)
                    </option>
                  )}
                  {efforts.map((effort) => (
                    <option key={effort} value={effort}>
                      {reasoningLabel(effort)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {clis.length > 0 && (
              <label>
                Coding CLI
                <select
                  aria-label={`Coding CLI for agent ${index + 1}`}
                  disabled={locked}
                  value={cli}
                  onChange={(event) => {
                    const next = clis.find((value) => value === event.target.value);
                    if (next) update(agent.id, { cli: next });
                  }}
                >
                  {clis.map((value) => (
                    <option key={value} value={value}>
                      {sandboxCliNames[value]}
                      {value === defaultSandboxCli(connection?.provider ?? '') ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Role
              <select
                aria-label={`Role for agent ${index + 1}`}
                value={agent.role ?? 'auto'}
                disabled={locked}
                onChange={(event) => {
                  const role = agentRoles.find((value) => value === event.target.value);
                  if (role) update(agent.id, { role });
                }}
              >
                {agentRoles.map((role) => (
                  <option key={role} value={role}>
                    {role[0].toUpperCase() + role.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            {!compare && (
              <button
                type="button"
                className="text-button"
                aria-label={`Remove agent ${index + 1}`}
                disabled={locked || agents.length <= 1}
                onClick={() => onChange(agents.filter((value) => value.id !== agent.id))}
              >
                Remove
              </button>
            )}
            {issue && (
              <p className="agent-connection-issue" role="alert">
                {issue}
                {agent.expectedModel && (
                  <>
                    {' '}
                    Previous model:{' '}
                    {modelDisplayName(agent.expectedProvider ?? '', agent.expectedModel)}.
                  </>
                )}
              </p>
            )}
            {effortIssue && (
              <p className="agent-connection-issue" role="alert">
                {effortIssue}
              </p>
            )}
          </fieldset>
        );
      })}
      <div className="roster-footer">
        <small>Auto chooses an eligible connected model within your workspace allowance.</small>
        <button type="button" className="text-button" disabled={locked} onClick={onProviders}>
          Manage models
        </button>
      </div>
      {loading && <small role="status">Loading connected models…</small>}
      {error && (
        <div className="roster-error">
          <small role="alert">
            Connected models could not be loaded. Auto is checked when you start.
          </small>
          <button type="button" className="text-button" disabled={locked} onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
    </section>
  );
}
