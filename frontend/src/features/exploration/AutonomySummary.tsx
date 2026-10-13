export function AutonomySummary({ run }: { run: Record<string, any> }) {
  const approval = run.autonomy_policy;
  if (!approval?.enabled) return null;
  const finite =
    approval.version === 1 &&
    approval.source_scope === 'project' &&
    [approval.max_repair_rounds, approval.max_concurrent_agents, approval.max_executions].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) &&
    approval.max_repair_rounds <= 2 &&
    approval.max_concurrent_agents <= 6 &&
    approval.max_executions <= 20;
  return (
    <div className="frozen-work-approval">
      <h4>Frozen work approval</h4>
      {finite ? (
        <p>
          Project source scope · up to {approval.max_concurrent_agents} agents concurrently ·{' '}
          {approval.max_executions} executions total · {approval.max_repair_rounds} repair rounds.{' '}
          {approval.allow_intent_questions === true
            ? 'Agents may ask the owner to clarify intent.'
            : 'Intent questions were not approved.'}
        </p>
      ) : (
        <p>
          The complete finite approval is unavailable in this response. Inspect the run details.
        </p>
      )}
      {Array.isArray(run.model_budgets) && run.model_budgets.length > 0 && (
        <details>
          <summary>Frozen model limits</summary>
          <ul>
            {run.model_budgets.map((budget: Record<string, any>) => (
              <li key={`${budget.provider}:${budget.model}`}>
                {budget.provider} / {budget.model} ·{' '}
                {Number.isSafeInteger(budget.max_requests)
                  ? `${budget.max_requests} requests`
                  : 'Request limit not recorded'}
                {Number.isSafeInteger(budget.spend_limit_microusd) &&
                  ` · $${(budget.spend_limit_microusd / 1e6).toFixed(2)} spend limit`}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="subtle">Publication requires a separate owner decision.</p>
    </div>
  );
}
