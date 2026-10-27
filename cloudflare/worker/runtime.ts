import type { Json } from './types';
export function checkLedger(snapshot: Json, request?: Json) {
  const requestedEffort = [
    ...(request?.adaptive_team?.requested_agents ?? []),
    ...(request?.agents ?? []),
  ].some((agent: Json) => agent.reasoning_effort != null);
  if (requestedEffort && snapshot?.capabilities?.reasoning_effort !== 1)
    throw Object.assign(
      new Error('Repository reasoning support is updating; refresh before starting.'),
      {
        code: 'LEDGER_UPDATING',
      },
    );
  const limits = snapshot?.capabilities?.agent_limits;
  const roots = request?.agents?.length ?? 0;
  const delegation = request?.delegation;
  if (
    snapshot?.capabilities?.artifact_reads !== 2 ||
    (request?._workspace_spend === true && snapshot?.capabilities?.workspace_spend !== 1) ||
    request?.model_budgets?.some(
      (budget: Json) =>
        budget.max_execution_ms > (snapshot?.capabilities?.max_execution_ms ?? 600_000),
    ) ||
    ((request?.model_budgets !== undefined || request?.restart_of !== undefined) &&
      snapshot?.capabilities?.model_budgets !== 1) ||
    (request?.mode === 'collaborate' && snapshot?.capabilities?.collaborative_runs !== 1) ||
    (request?.working_branch_id != null && snapshot?.capabilities?.working_branches !== 1) ||
    (request?.continuation_of !== undefined &&
      snapshot?.capabilities?.published_continuation !== 1) ||
    (request?.model_budgets?.some((budget: Json) => budget.max_requests == null) &&
      snapshot?.capabilities?.optional_model_requests !== 1) ||
    (roots === 1 && limits?.min_root_agents !== 1) ||
    (roots > 4 && (!limits || roots > limits.max_root_agents)) ||
    (delegation?.enabled === true &&
      (!limits ||
        delegation.max_depth > limits.max_delegation_depth ||
        delegation.max_executions > limits.max_run_executions))
  )
    throw Object.assign(
      new Error('Repository ledger code is still updating; retry after deployment propagation'),
      { code: 'LEDGER_UPDATING' },
    );
}
