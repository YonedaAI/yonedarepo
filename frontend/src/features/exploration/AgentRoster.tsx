import type { AgentLimits } from '../../lib/types';
import type { Provider } from '../workspace/ProviderSettings';
import { providerNames } from '../workspace/providerModels';
import { type AdaptiveAgentDraft, agentRoles, automaticAgent } from './adaptiveDraft';
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
}) {
  function update(id: string, patch: Partial<AdaptiveAgentDraft>) {
    onChange(agents.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent)));
  }
  return (
    <section className="agent-roster simple-agent-roster" aria-labelledby="agent-roster-heading">
      <div className="section-heading">
        <h3 id="agent-roster-heading">Agents</h3>
        <button
          type="button"
          className="quiet"
          disabled={locked || agents.length >= limits.max_root_agents}
          onClick={() => onChange([...agents, automaticAgent()])}
        >
          Add agent
        </button>
      </div>
      {agents.map((agent, index) => {
        const issue =
          !loading && agent.connection ? agentConnectionIssue(agent, providers) : undefined;
        const unavailable =
          !!agent.connection && !providers.some((provider) => provider.id === agent.connection);
        return (
          <fieldset className="agent-inputs seed-agent" key={agent.id}>
            <legend>Agent {index + 1}</legend>
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
                  })
                }
              >
                <option value="">Auto</option>
                {unavailable && (
                  <option value={agent.connection} disabled>
                    Previous connection (unavailable)
                  </option>
                )}
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label} · {providerNames[provider.provider] ?? provider.provider} ·{' '}
                    {provider.model}
                  </option>
                ))}
              </select>
            </label>
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
            <button
              type="button"
              className="text-button"
              aria-label={`Remove agent ${index + 1}`}
              disabled={locked || agents.length <= 1}
              onClick={() => onChange(agents.filter((value) => value.id !== agent.id))}
            >
              Remove
            </button>
            {issue && (
              <p className="agent-connection-issue" role="alert">
                {issue}
                {agent.expectedModel && (
                  <>
                    {' '}
                    Previous model: <code>{agent.expectedModel}</code>.
                  </>
                )}
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
