import { comparisonReviewAttempt } from './comparison-scope';
import type { Json } from './types';
export function checkLedger(snapshot: Json, request?: Json) {
  if (
    (request?.comparison != null ||
      request?.op === 'approve_comparison_review' ||
      request?.op === 'select_comparison_candidate') &&
    snapshot?.capabilities?.comparison_review !== 1
  )
    throw Object.assign(
      new Error('Comparison review support is updating; refresh before continuing.'),
      { code: 'LEDGER_UPDATING' },
    );
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
  if (request?.adaptive_team !== undefined && snapshot?.capabilities?.adaptive_teams !== 1)
    throw Object.assign(
      new Error('Automatic team planning is updating; refresh before starting.'),
      { code: 'LEDGER_UPDATING' },
    );
  if (
    request?.adaptive_team?.specialist_connection != null &&
    snapshot?.capabilities?.adaptive_specialists !== 1
  )
    throw Object.assign(
      new Error('Specialist model assignment is updating; refresh before starting.'),
      { code: 'LEDGER_UPDATING' },
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
    (request?.autonomy_policy != null && snapshot?.capabilities?.autonomous_repair !== 1) ||
    (request?.working_branch_id != null && snapshot?.capabilities?.working_branches !== 1) ||
    (request?.campaign != null && snapshot?.capabilities?.campaign_budget !== 1) ||
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
  try {
    compatibleRuntime(health, job);
  } catch (failure) {
    throw Object.assign(failure as Error, { code: 'RUNTIME_UPDATING' });
  }
}
function compatibleRuntime(health: Json, job: Json) {
  if (
    job.payload?.workspace_transport === 'api-source-v1' &&
    ['source_api', 'lazy_source', 'source_capture', 'child_privilege_drop'].some(
      (capability) => health?.capabilities?.[capability] !== 1,
    )
  )
    throw new Error('Container image lacks lazy source isolation; wait for rollout completion');
  if (job.kind === 'capture' && health?.capabilities?.platform_capture !== 1)
    throw new Error('Container image still pushes captures to Git; wait for rollout completion');
  if (
    (comparisonReviewAttempt(job) || job.payload?.execution?.comparison_approval_id != null) &&
    health?.capabilities?.comparison_review !== 1
  )
    throw new Error(
      'Container image does not support comparison review; wait for rollout completion',
    );
  if (
    job.payload?.execution?.reasoning_effort != null &&
    health?.capabilities?.reasoning_efforts !== 1
  )
    throw new Error(
      'Container image does not support the approved reasoning effort; wait for rollout completion',
    );
  if (job.payload?.run?.adaptive_team !== undefined && health?.capabilities?.adaptive_teams !== 1)
    throw new Error(
      'Container image does not support automatic team selection; wait for rollout completion',
    );
  if (health?.protocol !== 2)
    throw new Error('Previous container protocol is still serving; wait for rollout completion');
  if (job.payload?.policy?.build?.app != null && health.capabilities?.app_bundle !== 1)
    throw new Error('Container image cannot capture checked apps; wait for rollout completion');
  if (
    job.payload?.team_planning === true &&
    job.payload?.policy?.build?.app != null &&
    health.capabilities?.app_planning !== 1
  )
    throw new Error('Container image lacks managed app planning; wait for rollout completion');
  if (job.payload?.run?.autonomy_policy != null && health.capabilities?.agent_coordination !== 1)
    throw new Error(
      'Container image cannot coordinate autonomous repairs; wait for rollout completion',
    );
  if (job.payload?.policy?.build?.test_bundle != null && health.capabilities?.test_bundle !== 1)
    throw new Error(
      'Container image does not support the frozen test bundle; wait for rollout completion',
    );
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
