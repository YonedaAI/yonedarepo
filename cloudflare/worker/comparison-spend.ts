import { canonicalJson } from './canonical-json';
import { ledger } from './storage';
import type { Env, Json } from './types';
import { workspace } from './workspace';
import type { WorkspaceSpendContext } from './workspace-spend';

const fail = () =>
  Object.assign(new Error('Comparison billing differs from its immutable approval'), {
    code: 'WORKSPACE_SPEND_SCOPE',
  });
const config = (budget: Json) => {
  const { requests: _requests, charged_microusd: _charged, ...configuration } = budget;
  return canonicalJson(configuration);
};

/** This argument comes only from authenticated ledger readback, never provider JSON. */
export function comparisonSpendMatches(context: WorkspaceSpendContext, job: Json): boolean {
  const execution = job.payload?.execution;
  const frozen = job.payload?.run?.comparison?.approval;
  if (
    !frozen ||
    context.comparison_approval_id !== frozen.id ||
    context.comparison_approval_digest !== frozen.digest ||
    execution?.comparison_approval_id !== frozen.id ||
    execution.run_id !== context.run_id ||
    job.id !== context.job_id ||
    job.epoch !== context.epoch ||
    job.model !== context.model ||
    execution.provider !== context.provider ||
    execution.model !== job.model
  )
    return false;
  const expected =
    execution.comparison_role === 'reviewer'
      ? frozen.reviewer
      : ['builder', 'repair'].includes(execution.comparison_role) &&
          Number.isSafeInteger(execution.agent_index)
        ? frozen.builders?.[execution.agent_index]
        : undefined;
  if (
    !expected ||
    ['connection', 'provider', 'model', 'routing', 'version', 'reasoning_effort'].some(
      (key) =>
        canonicalJson(
          (key === 'connection' ? (expected.connection ?? expected.provider) : expected[key]) ??
            null,
        ) !== canonicalJson(execution[key] ?? null),
    )
  )
    return false;
  const approved = frozen.model_budget_configs?.find(
    (budget: Json) => budget.provider === context.provider && budget.model === context.model,
  );
  return Boolean(approved?.pricing) && config(approved) === config(context.model_budget);
}

export async function comparisonSpendForAttempt(
  env: Env,
  owner: string,
  repo: string,
  job: Json,
): Promise<WorkspaceSpendContext> {
  const execution = job.payload.execution;
  const approval = await ledger(env, repo, {
    op: 'comparison_approval',
    run_id: execution.run_id,
    approval_id: execution.comparison_approval_id,
    _workspace: owner,
  });
  const frozen = job.payload.run?.comparison?.approval;
  if (
    approval.version !== 1 ||
    approval.id !== frozen?.id ||
    approval.digest !== frozen.digest ||
    canonicalJson(approval.reviewer) !== canonicalJson(frozen.reviewer) ||
    canonicalJson(approval.builders) !== canonicalJson(frozen.builders)
  )
    throw fail();
  const budget = approval.model_budgets?.find(
    (budget: Json) => budget.provider === execution.provider && budget.model === job.model,
  );
  if (!budget) throw fail();
  const context: WorkspaceSpendContext = {
    owner,
    repo_id: repo,
    run_id: execution.run_id,
    job_id: job.id,
    epoch: job.epoch,
    provider: execution.provider,
    model: job.model,
    model_budget: budget,
    comparison_approval_id: approval.id,
    comparison_approval_digest: approval.digest,
  };
  if (!comparisonSpendMatches(context, job)) throw fail();
  const status = await workspace(env, owner, { op: 'workspace_spend_status' });
  if (!Number.isSafeInteger(status.version) || status.version < 1) throw fail();
  return context;
}
