import { campaignForAttempt } from './campaign-usage';
import { ledger } from './storage';
import type { Env, Json } from './types';
import { workspace } from './workspace';

/** Quota observations come from the workspace authority, never model or operator counts. */
export async function observeCampaignModelLimit(env: Env, owner: string, repo: string, job: Json) {
  const binding = await campaignForAttempt(env, owner, repo, job);
  if (!binding) return null;
  const state = await workspace(env, owner, { op: 'campaign_status', id: binding.id });
  if (state.enabled !== true || state.expires <= Date.now()) return null;
  const execution = job.payload.execution;
  const model = job.model ?? execution.model;
  const budget = binding.model_budgets.find(
    (entry: Json) => entry.provider === execution.provider && entry.model === model,
  );
  const chain = state.chains.find((entry: Json) => entry.id === binding.chain_id);
  const requests = chain?.models?.[`${execution.provider}/${model}`]?.requests;
  if (
    !Number.isSafeInteger(requests) ||
    !Number.isSafeInteger(budget?.max_requests) ||
    budget.max_requests < 1 ||
    requests < budget.max_requests
  )
    return null;
  const ceilings = [
    [state.charged_microusd, state.limit_microusd],
    [state.charged?.[binding.bucket], state.buckets?.[binding.bucket]],
    [chain.charged_microusd, state.approval?.chain_limit_microusd],
  ];
  if (
    ceilings.some(
      ([used, limit]) =>
        !Number.isSafeInteger(used) || !Number.isSafeInteger(limit) || used < 0 || limit <= 0,
    )
  )
    throw Object.assign(new Error('Authoritative campaign ceilings unavailable'), {
      code: 'FORBIDDEN',
    });
  // A model-specific observation cannot authorize recovery past any monetary ceiling.
  if (ceilings.some(([used, limit]) => used >= limit)) return null;
  return ledger(env, repo, {
    op: 'observe_campaign_model_limit',
    _workspace: owner,
    job_id: job.id,
    epoch: job.epoch,
    campaign_id: binding.id,
    campaign_version: binding.version,
    chain_id: binding.chain_id,
    requests,
    max_requests: budget.max_requests,
  });
}

/** Deployment recovery rereads both authorities; the operator supplies only job identity. */
export async function reconcileCampaignModelLimit(
  env: Env,
  owner: string,
  repo: string,
  id: string,
) {
  if (typeof id !== 'string' || !id || id.length > 256)
    throw Object.assign(new Error('A bounded job id is required'), { code: 'INVALID_INPUT' });
  const job = await ledger(env, repo, { op: 'job_status', id, _workspace: owner });
  if (job.kind !== 'agent' || typeof job.execution?.run_id !== 'string')
    throw Object.assign(new Error('A hosted campaign agent is required'), { code: 'FORBIDDEN' });
  const detail = await ledger(env, repo, {
    op: 'run_detail',
    run_id: job.execution.run_id,
    _workspace: owner,
  });
  const execution = detail.executions.find((entry: Json) => entry.id === job.execution.id);
  if (!execution)
    throw Object.assign(new Error('Authoritative execution unavailable'), { code: 'NOT_FOUND' });
  const result = await observeCampaignModelLimit(env, owner, repo, {
    ...job,
    model: execution.model,
    payload: { execution },
  });
  if (!result)
    throw Object.assign(new Error('No exhausted model allowance can be reconciled'), {
      code: 'CAMPAIGN_EXHAUSTED',
    });
  return result;
}
