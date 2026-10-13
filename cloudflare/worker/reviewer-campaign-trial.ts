import { campaignGrant } from './campaign-grant';
import { latestChecked } from './reviewer-campaign-evidence';
import { campaignTrialRequest, reviewerCampaignId } from './reviewer-campaign-policy';
import { checkLedger } from './runtime';
import { ledger } from './storage';
import type { Env, Json } from './types';
import { workspace } from './workspace';

export async function startCampaignTrial(env: Env, owner: string, requestId: string) {
  const status = await workspace(env, owner, { op: 'reviewer_campaign_status' });
  if (!status?.campaign?.enabled || status.campaign.reviewer_enabled !== true)
    throw new Error('Reviewer campaign is not enabled');
  const repo = status.approval.entry.repo_id;
  const id = `reviewer-campaign-${requestId}`;
  const branch = await ledger(env, repo, {
    op: 'working_branch',
    id: 'campaign-development',
    _workspace: owner,
  });
  const proposed = campaignTrialRequest(id, status.campaign.version, branch);
  const receipt = await workspace(env, owner, {
    op: 'campaign_trial',
    id: reviewerCampaignId,
    run_id: id,
    repo_id: repo,
    run_request: proposed,
  });
  const approval = receipt.approval;
  const repository = await ledger(env, repo, { op: 'repository_status', _workspace: owner });
  checkLedger({ capabilities: repository.capabilities }, approval);
  const binding = await workspace(env, owner, {
    op: 'campaign_bind_run',
    ...approval.campaign,
    repo_id: repo,
    run_id: id,
    model_budgets: [...approval.model_budgets, approval.repair_escalation.budget],
    repair_escalation: approval.repair_escalation,
    access: 'reviewer',
  });
  let existing: Json | null;
  try {
    existing = await ledger(env, repo, { op: 'run_detail', run_id: id, _workspace: owner });
  } catch (failure) {
    if ((failure as { code?: string }).code !== 'NOT_FOUND') throw failure;
    existing = null;
  }
  if (!existing) {
    try {
      const grant = await campaignGrant(env, owner, repo, approval, binding);
      await ledger(env, repo, {
        ...approval,
        op: 'start_run',
        _workspace: owner,
        _campaign_grant: grant,
      });
    } catch (failure) {
      const committed = await ledger(env, repo, {
        op: 'run_detail',
        run_id: id,
        _workspace: owner,
      }).catch(() => null);
      if (!committed) throw failure;
    }
  }
  return {
    repo_id: repo,
    run_id: id,
    campaign_id: reviewerCampaignId,
    url: `/?repo=${encodeURIComponent(repo)}&run=${encodeURIComponent(id)}`,
  };
}

/** Public campaign status retains historical evidence and never starts inference. */
export async function reviewerCampaignStatus(env: Env, owner: string): Promise<Json | null> {
  let status = await workspace(env, owner, { op: 'reviewer_campaign_status' });
  if (!status) return null;
  let activeState: 'reserved' | 'running' | null = null;
  const active = status.campaign.active_trial;
  if (active) {
    let detail: Json | null;
    try {
      detail = await ledger(env, status.approval.entry.repo_id, {
        op: 'run_detail',
        run_id: active,
        _workspace: owner,
      });
    } catch (failure) {
      if ((failure as { code?: string }).code !== 'NOT_FOUND') throw failure;
      detail = null;
    }
    if (detail) {
      const run = detail.run ?? detail.runs?.[0];
      const executing = detail.executions?.some((execution: Json) =>
        ['queued', 'running', 'capturing', 'evaluating'].includes(execution.status),
      );
      if (['ready', 'accepted', 'failed', 'cancelled'].includes(run?.status) && !executing) {
        await workspace(env, owner, {
          op: 'campaign_trial_complete',
          id: reviewerCampaignId,
          run_id: active,
        });
        status = await workspace(env, owner, { op: 'reviewer_campaign_status' });
      } else activeState = 'running';
    } else activeState = 'reserved';
  }
  const campaign = status.campaign;
  return {
    ...status,
    campaign: { ...campaign, enabled: campaign.enabled && campaign.reviewer_enabled === true },
    campaign_id: campaign.id,
    enabled: campaign.enabled && campaign.reviewer_enabled === true,
    version: campaign.version,
    revision: campaign.revision,
    expires: campaign.expires,
    repo_id: status.approval.entry.repo_id,
    working_branch_id: 'campaign-development',
    active_trial: campaign.active_trial ?? null,
    active_trial_state: activeState,
    budget: {
      limit_microusd: campaign.limit_microusd,
      charged_microusd: campaign.charged_microusd,
      buckets: campaign.buckets,
      charged: campaign.charged,
    },
    latest_checked: await latestChecked(env, owner, status.approval.entry.repo_id),
  };
}
