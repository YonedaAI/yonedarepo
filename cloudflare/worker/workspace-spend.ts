import { canonicalJson } from './canonical-json';
import { ledger } from './storage';
import type { Env, Json } from './types';
import { workspace } from './workspace';

export type WorkspaceSpendContext = {
  owner: string;
  repo_id: string;
  run_id: string;
  job_id: string;
  epoch: number;
  provider: string;
  model: string;
  model_budget: Json;
};
export type WorkspaceSpendReservation = { id: string; identity: Json; amount: number };
const fail = (message: string) =>
  Object.assign(new Error(message), { code: 'WORKSPACE_SPEND_SCOPE' });
const money = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;

/** Only immutable server-run markers opt in; provider JSON cannot select a billing mode. */
export function workspaceSpendRun(run: Json | undefined): boolean {
  return run?.workspace_spend?.version === 1 || run?.adaptive_team?.version === 1;
}
function budgetConfiguration(budget: Json): string {
  const { requests: _requests, charged_microusd: _charged, ...configuration } = budget;
  return canonicalJson(configuration);
}
/** The separate argument is trusted Worker authority, never a provider-input flag. */
export function workspaceSpendApprovesJob(context: WorkspaceSpendContext, job: Json): boolean {
  const execution = job.payload?.execution;
  const run = job.payload?.run;
  const budget = run?.model_budgets?.find(
    (b: Json) => b.provider === context.provider && b.model === context.model,
  );
  return (
    workspaceSpendRun(run) &&
    Boolean(budget?.pricing) &&
    job.id === context.job_id &&
    job.epoch === context.epoch &&
    execution?.run_id === context.run_id &&
    execution?.provider === context.provider &&
    job.model === context.model &&
    budgetConfiguration(budget) === budgetConfiguration(context.model_budget)
  );
}

export function validateWorkspaceSpendRun(run: Json) {
  const budgets = run.model_budgets;
  if (!Array.isArray(budgets) || budgets.length === 0)
    throw fail('Workspace inference requires priced approved model groups');
  const groups = new Set<string>();
  for (const budget of budgets) {
    const group = `${budget.provider}/${budget.model}`;
    if (
      typeof budget.provider !== 'string' ||
      typeof budget.model !== 'string' ||
      groups.has(group) ||
      !budget.pricing ||
      !money(budget.pricing.input_microusd_per_million) ||
      !money(budget.pricing.output_microusd_per_million) ||
      typeof budget.pricing.source !== 'string' ||
      !budget.pricing.source
    )
      throw fail('Every pooled model group requires unique frozen pricing');
    groups.add(group);
  }
}

export async function workspaceSpendForAttempt(env: Env, owner: string, repo: string, job: Json) {
  if (!workspaceSpendRun(job.payload?.run)) {
    await assertLegacyInferenceAllowed(env, owner);
    return null;
  }
  const execution = job.payload.execution;
  const detail = await ledger(env, repo, {
    op: 'run_detail',
    run_id: execution.run_id,
    _workspace: owner,
  });
  const run = detail.run;
  if (!run || !workspaceSpendRun(run))
    throw fail('Authoritative workspace spend approval unavailable');
  validateWorkspaceSpendRun(run);
  const model = job.model ?? execution.model;
  const budget = run.model_budgets.find(
    (b: Json) => b.provider === execution.provider && b.model === model,
  );
  if (!budget) throw fail('Attempt model is outside the frozen workspace pool');
  return {
    owner,
    repo_id: repo,
    run_id: run.id,
    job_id: job.id,
    epoch: job.epoch,
    provider: execution.provider,
    model,
    model_budget: budget,
  } satisfies WorkspaceSpendContext;
}

export function workspaceSpendStatus(env: Env, owner: string) {
  return workspace(env, owner, { op: 'workspace_spend_status' });
}
/** Transition never reinterprets an old approval or double-debits its historical reservation. */
export async function assertLegacyInferenceAllowed(env: Env, owner: string) {
  if (owner === '_admin') return;
  const status = await workspaceSpendStatus(env, owner);
  if (!Number.isSafeInteger(status.version) || status.version < 0)
    throw fail('Authoritative workspace allowance version unavailable');
  if (status.version >= 1)
    throw Object.assign(new Error('Use a new workspace-approved run after allowance transition'), {
      code: 'WORKSPACE_LEGACY_INFERENCE_BLOCKED',
    });
}
export function workspaceSpendConfigure(
  env: Env,
  owner: string,
  expectedVersion: number,
  limit: number,
) {
  return workspace(env, owner, {
    op: 'workspace_spend_configure',
    expected_version: expectedVersion,
    limit_microusd: limit,
  });
}

export async function reserveWorkspaceSpend(
  env: Env,
  context: WorkspaceSpendContext,
  id: string,
  counted: Json,
): Promise<WorkspaceSpendReservation> {
  if (
    !money(counted.reservation_microusd) ||
    typeof counted.reservation_id !== 'string' ||
    !Number.isSafeInteger(counted.number) ||
    counted.number < 1 ||
    counted.model_budget?.provider !== context.provider ||
    counted.model_budget?.model !== context.model ||
    !counted.model_budget?.pricing ||
    !context.model_budget ||
    budgetConfiguration(counted.model_budget) !== budgetConfiguration(context.model_budget)
  )
    throw fail('Authoritative priced run reservation required before shared workspace spending');
  const reservation = {
    id,
    amount: counted.reservation_microusd,
    identity: {
      repo_id: context.repo_id,
      run_id: context.run_id,
      job_id: context.job_id,
      epoch: context.epoch,
      request_number: counted.number,
      provider: context.provider,
      model: context.model,
      ledger_reservation_id: counted.reservation_id,
    },
  };
  await workspace(env, context.owner, { op: 'workspace_spend_reserve', ...reservation });
  return reservation;
}

export async function settleWorkspaceSpend(
  env: Env,
  owner: string,
  reservation: WorkspaceSpendReservation,
  amount: number,
  usage: Json,
) {
  if (
    !money(amount) ||
    amount > reservation.amount ||
    !money(usage.input_tokens) ||
    !money(usage.output_tokens)
  )
    throw fail('Workspace settlement exceeds the authoritative run reservation');
  return workspace(env, owner, {
    op: 'workspace_spend_settle',
    id: reservation.id,
    identity: reservation.identity,
    amount,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
  });
}
