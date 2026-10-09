import type { AgentLimits } from '../../lib/types';
import type { DelegationDraft } from './agentLimits';

export function DelegationSettings({
  value,
  roots,
  limits,
  locked,
  onChange,
}: {
  value: DelegationDraft;
  roots: number;
  limits: AgentLimits;
  locked: boolean;
  onChange: (value: DelegationDraft) => void;
}) {
  const supported = limits.max_delegation_depth > 0;
  return (
    <section className="delegation-settings" aria-labelledby="delegation-heading">
      <h3 id="delegation-heading">Subagent delegation</h3>
      <label className="delegation-toggle">
        <input
          type="checkbox"
          checked={supported && value.enabled}
          disabled={locked || !supported}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
          aria-describedby="delegation-description"
        />
        Allow agents to create subagents
      </label>
      <p id="delegation-description" className="subtle">
        {supported
          ? 'Agents may delegate independent approaches; all changes still require checks and your shipping decision.'
          : 'This deployment supports root agents only. Subagent delegation is unavailable until the backend is upgraded.'}
      </p>
      {supported && value.enabled && (
        <>
          <div className="delegation-controls">
            <label>
              Maximum total agents
              <select
                value={Math.max(roots, value.max_executions)}
                disabled={locked}
                onChange={(event) =>
                  onChange({ ...value, max_executions: Number(event.target.value) })
                }
              >
                {Array.from(
                  { length: limits.max_run_executions - roots + 1 },
                  (_, i) => roots + i,
                ).map((count) => (
                  <option key={count} value={count}>
                    {count} total · {count - roots} subagent{count - roots === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Delegation depth
              <select
                value={value.max_depth}
                disabled={locked}
                onChange={(event) => onChange({ ...value, max_depth: Number(event.target.value) })}
              >
                {Array.from({ length: limits.max_delegation_depth }, (_, i) => i + 1).map(
                  (depth) => (
                    <option key={depth} value={depth}>
                      {depth === 1
                        ? '1 level · root → subagent'
                        : '2 levels · subagents may delegate'}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>
          <p className="subtle">
            The total includes {roots} root agents. Children inherit their parent’s provider and
            model and billing source. Subagents share any request or dollar limits you set for that
            model and can increase provider usage.
          </p>
          {value.max_executions <= roots && (
            <p className="subtle">Increase the total above {roots} to leave room for subagents.</p>
          )}
        </>
      )}
    </section>
  );
}
