import { campaignForAttempt } from './campaign-usage';
import { ledger } from './storage';
import type { Env, Json } from './types';
import { workspace } from './workspace';

/** One explicit owner recovery: observe existing authority, never mint or reset an approval. */
export async function retryCampaignCoordinator(env: Env, owner: string, input: Json) {
  const repository = await ledger(env, input.repo_id, {
    op: 'repository_status',
    _workspace: owner,
  });
  if (repository.capabilities?.coordinator_retry !== 1)
    throw Object.assign(new Error('Coordinator recovery code is still updating'), {
      code: 'LEDGER_UPDATING',
    });
  const detail = await ledger(env, input.repo_id, {
    op: 'run_detail',
    run_id: input.run_id,
    _workspace: owner,
  });
  const run = detail.run;
  const command = {
    op: 'retry_coordinator',
    _workspace: owner,
    run_id: input.run_id,
    request_id: input.request_id,
    expected_coordinator_job: input.expected_coordinator_job,
    expected_epoch: input.expected_epoch,
    expected_commit: input.expected_commit,
    expected_version: input.expected_version,
    expected_plan_revision: input.expected_plan_revision,
  };
  // A replay returns an existing receipt even if funding was subsequently disabled.
  if (run?.coordinator_owner_retry) return ledger(env, input.repo_id, command);
  const execution = detail.executions?.find((e: Json) => e.id === run?.coordinator_execution_id);
  if (!execution)
    throw Object.assign(new Error('Existing campaign coordinator required'), { code: 'NOT_FOUND' });
  const binding = await campaignForAttempt(env, owner, input.repo_id, {
    model: execution.model,
    payload: { execution },
  });
  if (binding?.access !== 'owner')
    throw Object.assign(new Error('Original owner campaign approval required'), {
      code: 'FORBIDDEN',
    });
  const state = await workspace(env, owner, { op: 'campaign_status', id: binding.id });
  const chain = state.chains?.find((c: Json) => c.id === binding.chain_id);
  if (state.enabled !== true || state.expires <= Date.now() || !chain)
    throw Object.assign(new Error('Original campaign is disabled or unavailable'), {
      code: 'CAMPAIGN_DISABLED',
    });
  const agents = run.agents ?? [];
  const observations: Json[] = [];
  for (const agent of agents) {
    if (agent.model === 'claude-opus-5-5') continue;
    const frozen = binding.model_budgets.find(
      (b: Json) => b.provider === agent.provider && b.model === agent.model,
    );
    const shared = chain.models?.[`${agent.provider}/${agent.model}`];
    if (
      frozen &&
      shared &&
      (shared.requests >= frozen.max_requests ||
        shared.charged_microusd >= frozen.spend_limit_microusd)
    ) {
      if (
        !observations.some(
          (group) => group.provider === agent.provider && group.model === agent.model,
        )
      )
        observations.push({
          provider: agent.provider,
          model: agent.model,
          requests: shared.requests,
          max_requests: frozen.max_requests,
          charged_microusd: shared.charged_microusd,
          spend_limit_microusd: frozen.spend_limit_microusd,
        });
    }
  }
  const preferred = run.team_plan?.integrator_agent;
  const available = [preferred, ...agents.map((_: Json, index: number) => index)]
    .map((index) => agents[index])
    .find((agent) => {
      if (
        !agent ||
        agent.model === 'claude-opus-5-5' ||
        observations.some((g) => g.provider === agent.provider && g.model === agent.model) ||
        run.unavailable_model_groups?.some(
          (g: Json) => g.provider === agent.provider && g.model === agent.model,
        )
      )
        return false;
      const local = run.model_budgets?.find(
        (b: Json) => b.provider === agent.provider && b.model === agent.model,
      );
      return (
        local &&
        local.requests < local.max_requests &&
        local.charged_microusd < local.spend_limit_microusd
      );
    });
  const budget = binding.model_budgets.find(
    (b: Json) => b.provider === available?.provider && b.model === available?.model,
  );
  const usage = available && chain.models?.[`${available.provider}/${available.model}`];
  const counters = [
    [state.charged_microusd, state.limit_microusd],
    [state.charged?.[binding.bucket], state.buckets?.[binding.bucket]],
    [chain.charged_microusd, state.approval?.chain_limit_microusd],
    [usage?.requests ?? 0, budget?.max_requests],
    [usage?.charged_microusd ?? 0, budget?.spend_limit_microusd],
  ];
  if (
    !available ||
    !budget ||
    counters.some(
      ([used, cap]) =>
        !Number.isSafeInteger(used) ||
        !Number.isSafeInteger(cap) ||
        used < 0 ||
        cap <= 0 ||
        used >= cap,
    )
  )
    throw Object.assign(
      new Error('Original campaign allowance is exhausted; recovery cannot add funding'),
      { code: 'CAMPAIGN_EXHAUSTED' },
    );
  return ledger(env, input.repo_id, { ...command, _shared_model_limits: observations });
}
