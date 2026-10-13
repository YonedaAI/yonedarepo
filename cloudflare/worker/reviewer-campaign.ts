import { username } from './accounts';
import { error, readJson, response, safeId } from './http';
import { checkedFinal, latestChecked } from './reviewer-campaign-evidence';
import { campaignModelBudgets, reviewerCampaignId } from './reviewer-campaign-policy';
import { reviewerCampaignStatus, startCampaignTrial } from './reviewer-campaign-trial';
import { ledger } from './storage';
import type { Env, Json, Principal } from './types';
import { providerCredentials, seal } from './vault';
import { workspace } from './workspace';

export {
  campaignModelBudgets,
  campaignTrialRequest,
  reviewerCampaignId,
} from './reviewer-campaign-policy';
export { reviewerCampaignStatus, startCampaignTrial } from './reviewer-campaign-trial';

async function configure(env: Env, owner: string, input: Json) {
  const old = await workspace(env, owner, { op: 'reviewer_status' });
  if (!old?.repo_id || input.repo_id === old.repo_id || !safeId(input.repo_id))
    throw new Error('A fresh event-booking repository and existing reviewer account are required');
  const repository = await ledger(env, input.repo_id, {
    op: 'repository_status',
    _workspace: owner,
  });
  if (repository.workspace !== owner || !repository.policy?.build?.app)
    throw new Error('Reviewer campaign requires its ready fullstack event-booking profile');
  const branch = await ledger(env, input.repo_id, {
    op: 'working_branch',
    id: 'campaign-development',
    _workspace: owner,
  });
  if (branch.status !== 'active')
    throw new Error('Precreate active campaign-development working branch');
  const zaiConnection = 'owner-campaign-glm-20261012';
  const zai = await providerCredentials(env, '_admin', 'zai');
  await workspace(env, owner, {
    op: 'provider_put',
    provider: 'zai',
    model: 'glm-5.3-flash',
    connection: zaiConnection,
    label: 'Operator-only checked GLM evidence',
    sealed: await seal(env, owner, 'zai', zai.key, zaiConnection),
  });
  const { key } = await providerCredentials(env, '_admin', 'codex');
  const connection = 'reviewer-campaign-codex-20261012';
  await workspace(env, owner, {
    op: 'provider_put',
    provider: 'codex',
    model: 'gpt-5.6-luna',
    connection,
    label: 'Optional metered event-booking execution',
    sealed: await seal(env, owner, 'codex', key, connection),
  });
  const opusConnection = 'reviewer-campaign-opus-20261012';
  const opus = await providerCredentials(env, '_admin', 'claude');
  await workspace(env, owner, {
    op: 'provider_put',
    provider: 'claude',
    model: 'claude-opus-5-5',
    connection: opusConnection,
    label: 'Approved one-shot second repair',
    sealed: await seal(env, owner, 'claude', opus.key, opusConnection),
  });
  const sonnetConnection = 'owner-campaign-sonnet-20261012';
  await workspace(env, owner, {
    op: 'provider_put',
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    connection: sonnetConnection,
    label: 'Optional operator-only Sonnet execution',
    sealed: await seal(env, owner, 'claude', opus.key, sonnetConnection),
  });
  return workspace(env, owner, {
    op: 'campaign_configure',
    id: reviewerCampaignId,
    expected_version: input.expected_version ?? 0,
    approval: {
      version: input.version ?? 1,
      profile: 'reviewer-event-booking-v1',
      audience: 'owner',
      repo_ids: [input.repo_id],
      expires: old.expires,
      limit_microusd: 50000000,
      chain_limit_microusd: 5000000,
      buckets: { routine: 35000000, opus: 10000000, reserve: 5000000 },
      model_budgets: campaignModelBudgets,
      entry: {
        repo_id: input.repo_id,
        working_branch_id: 'campaign-development',
        glm_evidence_run_id: input.glm_evidence_run_id ?? null,
        default: 'latest_checked_final',
        coding_plan: 'owner_only',
        optional_execution: 'metered_codex',
      },
    },
  });
}

export async function reviewerCampaignRoute(req: Request, env: Env, principal: Principal) {
  const path = new URL(req.url).pathname;
  if (path.startsWith('/api/admin/reviewer/campaign/')) {
    if (principal.role !== 'admin') return error('FORBIDDEN', 'Administrator required', 403);
    if (req.method !== 'POST') return error('FORBIDDEN', 'POST required', 403);
    const input = await readJson(req);
    const owner = username(input.username);
    if (path.endsWith('/configure')) return response(await configure(env, owner, input));
    let verifiedRun: string | undefined;
    if (path.endsWith('/enable')) {
      const configured = await workspace(env, owner, { op: 'reviewer_campaign_status' });
      if (!configured) return error('NOT_FOUND', 'Configure campaign funding first', 409);
      const runId =
        input.glm_evidence_run_id ??
        configured.campaign.glm_evidence_run_id ??
        configured.approval.entry.glm_evidence_run_id;
      verifiedRun = runId;
      const evidence = await ledger(env, configured.approval.entry.repo_id, {
        op: 'run_detail',
        run_id: runId,
        _workspace: owner,
      });
      if (
        !checkedFinal(evidence) ||
        !evidence.executions?.some(
          (execution: Json) =>
            execution.provider === 'zai' &&
            execution.model === 'glm-5.3-flash' &&
            execution.status === 'completed',
        )
      )
        throw new Error(
          'Completed independently checked GLM evidence is required before enabling reviewer entry',
        );
    }
    if (path.endsWith('/enable') || path.endsWith('/disable'))
      return response(
        await workspace(env, owner, {
          op: path.endsWith('/enable') ? 'reviewer_campaign_enable' : 'campaign_disable',
          id: reviewerCampaignId,
          expected_version: input.expected_version,
          expected_revision: input.expected_revision,
          local_gate_receipt: input.local_gate_receipt,
          glm_evidence_run_id: verifiedRun,
        }),
      );
    return error('NOT_FOUND', 'Unknown campaign operation', 404);
  }
  if (!path.startsWith('/api/reviewer/campaign')) return null;
  if (!principal.reviewer) return error('FORBIDDEN', 'Reviewer account required', 403);
  const owner = principal.workspace;
  const status = await reviewerCampaignStatus(env, owner);
  if (req.method === 'GET' && path === '/api/reviewer/campaign') return response(status);
  if (!status?.enabled) return error('CAMPAIGN_DISABLED', 'Reviewer campaign is not enabled', 409);
  if (req.method === 'GET' && path.endsWith('/checked'))
    return response(await latestChecked(env, owner, status.repo_id));
  if (req.method === 'POST' && path.endsWith('/resume')) {
    if (!status.active_trial) return error('NO_ACTIVE_TRIAL', 'No campaign trial to resume', 409);
    return response(
      await startCampaignTrial(env, owner, status.active_trial.replace(/^reviewer-campaign-/, '')),
    );
  }
  if (req.method === 'POST' && path.endsWith('/trial')) {
    const input = await readJson(req);
    if (typeof input.request_id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(input.request_id))
      return error('INVALID_INPUT', 'Stable request ID required');
    return response(await startCampaignTrial(env, owner, input.request_id));
  }
  return error('NOT_FOUND', 'Unknown reviewer campaign operation', 404);
}
