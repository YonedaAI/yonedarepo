import { requestUsage } from './model-budget';
import { ledger } from './storage';
import type { Env, Json } from './types';
import { workspace } from './workspace';

/** Check the same authoritative binding again at the actual run reservation boundary. */
export function verifyCampaignReservation(binding: Json | null, reservation: Json) {
  const keys = ['id', 'version', 'chain_id', 'bucket', 'purpose'];
  const observed = reservation.campaign;
  const matches = binding
    ? observed &&
      typeof observed === 'object' &&
      !Array.isArray(observed) &&
      Object.keys(observed).length === keys.length &&
      keys.every((key) => observed[key] === binding[key])
    : observed === undefined;
  if (!matches)
    throw Object.assign(
      new Error('Campaign reservation differs from the authoritative run approval'),
      {
        code: 'LEDGER_UPDATING',
      },
    );
}

/** Read the persisted run through the attempt's trusted repository, never the model input. */
export async function campaignForAttempt(env: Env, owner: string, repo: string, job: Json) {
  const runId = job.payload.execution.run_id;
  const detail = await ledger(env, repo, { op: 'run_detail', run_id: runId });
  const run = detail.run ?? detail.runs?.find((entry: Json) => entry.id === runId);
  if (!run) throw new Error('Authoritative run approval unavailable');
  if (run.campaign === undefined) {
    let bound: Json | null;
    try {
      bound = await workspace(env, owner, {
        op: 'campaign_run_status',
        repo_id: repo,
        run_id: runId,
      });
    } catch (failure) {
      if ((failure as { code?: string }).code !== 'NOT_FOUND') throw failure;
      bound = null;
    }
    if (bound)
      throw Object.assign(
        new Error('Repository ledger must freeze campaign approvals before inference'),
        { code: 'LEDGER_UPDATING' },
      );
    return null;
  }
  const binding = await workspace(env, owner, {
    op: 'campaign_run_status',
    repo_id: repo,
    run_id: runId,
  });
  for (const key of ['id', 'version', 'chain_id', 'bucket', 'purpose'])
    if (binding[key] !== run.campaign[key]) throw new Error('Campaign run approval changed');
  if (
    job.model === 'claude-opus-5-5' &&
    (run.campaign_opus?.used !== true ||
      run.campaign_opus?.execution_id !== job.payload.execution.id ||
      run.team_repair_rounds !== 2)
  )
    throw new Error('Opus execution is outside the original one-shot repair approval');
  const configured = run.model_budgets?.map((budget: Json) => {
    const { requests: _requests, charged_microusd: _charged, ...configuration } = budget;
    return configuration;
  });
  // Rust serialization adds zero usage counters; compare configurations by fields.
  if (
    !Array.isArray(configured) ||
    configured.length !== binding.model_budgets.length ||
    configured.some(
      (budget: Json) =>
        !binding.model_budgets.some((approved: Json) =>
          Object.entries(budget).every(
            ([key, value]) => JSON.stringify(approved[key]) === JSON.stringify(value),
          ),
        ),
    )
  )
    throw new Error('Run model budgets differ from campaign approval');
  return binding;
}

export async function reserveCampaignUsage(
  env: Env,
  owner: string,
  binding: Json,
  reservationId: string,
  provider: string,
  model: string,
  body: Json,
  harness: string,
  amount: number,
  countOnly: boolean,
) {
  return workspace(env, owner, {
    op: 'campaign_reserve',
    repo_id: binding.repo_id,
    run_id: binding.run_id,
    reservation_id: reservationId,
    provider,
    model,
    ...requestUsage(body, harness),
    amount,
    count_only: countOnly,
  });
}

export async function settleCampaignUsage(
  env: Env,
  owner: string,
  binding: Json,
  reservationId: string,
  provider: string,
  model: string,
  usage: Json,
) {
  return workspace(env, owner, {
    op: 'campaign_settle',
    repo_id: binding.repo_id,
    run_id: binding.run_id,
    reservation_id: reservationId,
    provider,
    model,
    ...usage,
  });
}
