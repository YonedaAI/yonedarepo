import type { Json } from './types';
export function checkLedger(snapshot: Json, request?: Json) {
  const limits = snapshot?.capabilities?.agent_limits;
  const roots = request?.agents?.length ?? 0;
  const delegation = request?.delegation;
  if (
    snapshot?.capabilities?.artifact_reads !== 2 ||
    request?.model_budgets?.some(
      (budget: Json) =>
        budget.max_execution_ms > (snapshot?.capabilities?.max_execution_ms ?? 600_000),
    ) ||
    ((request?.model_budgets !== undefined || request?.restart_of !== undefined) &&
      snapshot?.capabilities?.model_budgets !== 1) ||
    (request?.mode === 'collaborate' && snapshot?.capabilities?.collaborative_runs !== 1) ||
    (request?.mode === 'collaborate' &&
      request?.team == null &&
      snapshot?.capabilities?.team_planning !== 1) ||
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
// Worker and image deploy separately; refuse incompatible images before model calls.
export function checkRuntime(health: Json, job: Json) {
  if (health?.protocol !== 2)
    throw new Error('Previous container protocol is still serving; wait for rollout completion');
  if (job.payload?.team_planning === true && health.capabilities?.team_planning !== 1)
    throw new Error('Container image does not support team planning; wait for rollout completion');
  if (job.payload?.execution?.team_task && health.capabilities?.collaborative_runs !== 1)
    throw new Error(
      'Container image does not support collaborative source assembly; wait for rollout completion',
    );
  if (
    job.kind === 'agent' &&
    job.payload?.run?.context_usage_version === 1 &&
    health.capabilities?.context_usage !== 1
  )
    throw new Error(
      'Container image does not support context evidence; wait for rollout completion',
    );
  if (
    job.kind === 'agent' &&
    job.payload?.run?.context_study !== undefined &&
    health.capabilities?.context_study !== 1
  )
    throw new Error(
      'Container image does not support context study isolation; wait for rollout completion',
    );
  if (
    job.payload?.run?.model_budgets?.some(
      (budget: Json) =>
        budget.max_execution_ms > (health?.capabilities?.max_execution_ms ?? 600_000),
    )
  )
    throw new Error(
      'Container image does not support the approved execution time; wait for rollout completion',
    );
  if (
    job.payload?.run?.model_budgets?.some((budget: Json) => budget.max_requests == null) &&
    health?.capabilities?.optional_model_requests !== 1
  )
    throw new Error(
      'Container image does not support optional request limits; wait for rollout completion',
    );
  if (
    job.kind === 'agent' &&
    job.payload?.run?.model_budgets !== undefined &&
    health.capabilities?.model_budgets !== 1
  )
    throw new Error(
      'Container image does not support approved model budgets; wait for rollout completion',
    );
  if (
    job.kind === 'agent' &&
    job.payload?.execution?.harness === 'gemini' &&
    !health.harnesses?.includes('gemini')
  )
    throw new Error('Container image does not support Gemini; wait for rollout completion');
  if (job.payload?.policy?.build && !health.suites?.includes('commands-v1'))
    throw new Error('Container image does not support general repository runs');
  if (
    job.kind === 'agent' &&
    (job.payload?.run?.delegation?.enabled || job.payload?.execution?.parent_execution) &&
    health.capabilities?.agent_delegation !== 1
  )
    throw new Error('Container image does not support subagents; wait for rollout completion');
  if (
    job.kind === 'evaluate' &&
    ((health.environment !== job.payload.policy.environment &&
      !health.environments?.includes(job.payload.policy.environment)) ||
      !Array.isArray(health.suites) ||
      !health.suites.includes(job.payload.policy.suite))
  )
    throw new Error(
      'Evaluator image does not support the requested policy; wait for rollout completion',
    );
}
export function modelForJob(job: Json, defaults: { codex: string; claude: string }) {
  return job.model ?? defaults[job.payload.execution?.harness === 'codex' ? 'codex' : 'claude'];
}
