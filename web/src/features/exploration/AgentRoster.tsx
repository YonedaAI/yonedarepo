import type { AgentLimits } from '../../lib/types';
import { type Provider, providerNames } from '../workspace/ProviderSettings';
import { ApproachPicker } from './ApproachPicker';
import type { AgentDraft } from './agentLimits';
import { nextApproach } from './approaches';
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
  agents: AgentDraft[];
  providers: Provider[];
  loading: boolean;
  error: string;
  limits: AgentLimits;
  locked: boolean;
  onChange: (agents: AgentDraft[]) => void;
  onProviders: () => void;
  onRetry: () => void;
}) {
  function update(id: string, patch: Partial<AgentDraft>) {
    onChange(agents.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent)));
  }
  return (
    <section className="agent-roster" aria-labelledby="agent-roster-heading">
      <div className="section-heading">
        <h3 id="agent-roster-heading">Independent approaches</h3>
        <button
          type="button"
          className="quiet"
          disabled={locked || loading || agents.length >= limits.max_root_agents}
          onClick={() =>
            onChange([
              ...agents,
              {
                id: crypto.randomUUID(),
                connection: providers[agents.length % providers.length]?.id ?? '',
                strategy: nextApproach(agents.map((agent) => agent.strategy)),
              },
            ])
          }
        >
          Add agent
        </button>
      </div>
      <p className="subtle">
        {agents.length} of {limits.max_root_agents} root agents · minimum {limits.min_root_agents}.
        Give each a distinct approach. Provider connections can be reused. Work runs as capacity
        becomes available.
      </p>
      {loading ? (
        <p role="status">Loading provider connections…</p>
      ) : error ? (
        <div className="inline-empty">
          <p role="alert">Could not load provider connections: {error}</p>
          <button type="button" className="quiet" disabled={locked} onClick={onRetry}>
            Retry connections
          </button>
        </div>
      ) : !providers.length ? (
        <div className="inline-empty">
          <p>Connect a provider key before starting hosted agents.</p>
          <button type="button" className="quiet" disabled={locked} onClick={onProviders}>
            Connect provider
          </button>
        </div>
      ) : null}
      {agents.map((agent, index) => (
        <fieldset className="agent-inputs" key={agent.id}>
          <legend>Root agent {index + 1}</legend>
          <label>
            Provider connection
            <select
              required
              disabled={locked || loading || !providers.length}
              value={agentConnectionIssue(agent, providers) ? '' : agent.connection}
              onChange={(event) =>
                update(agent.id, {
                  connection: event.target.value,
                  expectedProvider: undefined,
                  expectedModel: undefined,
                  fromPreviousRun: false,
                })
              }
            >
              <option value="">Choose a provider connection</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label} · {providerNames[provider.provider] ?? provider.provider} ·{' '}
                  {provider.model}
                </option>
              ))}
            </select>
          </label>
          {!loading && agentConnectionIssue(agent, providers) && (
            <p className="agent-connection-issue" role="alert">
              {agentConnectionIssue(agent, providers)}
              {agent.expectedModel && (
                <>
                  {' '}
                  Previous model: <code>{agent.expectedModel}</code>.
                </>
              )}
            </p>
          )}
          <ApproachPicker
            value={agent.strategy}
            used={agents.filter((other) => other.id !== agent.id).map((other) => other.strategy)}
            disabled={locked}
            onChange={(strategy) => update(agent.id, { strategy })}
          />
          {agents.length > limits.min_root_agents && (
            <button
              type="button"
              className="text-button"
              aria-label={`Remove root agent ${index + 1}`}
              disabled={locked}
              onClick={() => onChange(agents.filter((value) => value.id !== agent.id))}
            >
              Remove agent
            </button>
          )}
        </fieldset>
      ))}
    </section>
  );
}
