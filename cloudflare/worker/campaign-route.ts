import { username } from './accounts';
import { retryCampaignCoordinator } from './campaign-coordinator';
import { campaignGrant } from './campaign-grant';
import { reconcileCampaignModelLimit } from './campaign-model-limit';
import { provisionCampaignProject } from './campaign-provision';
import { campaignRepository } from './campaign-repository';
import { error, readJson, response } from './http';
import { checkLedger } from './runtime';
import { ledger } from './storage';
import type { Env, Principal } from './types';
import { workspace } from './workspace';

/** Campaign lifecycle is operator-only. Generic owner/model bodies cannot mint approvals. */
export async function campaignRoute(req: Request, env: Env, principal: Principal) {
  const path = new URL(req.url).pathname;
  if (!path.startsWith('/api/admin/campaign/')) return null;
  if (principal.role !== 'admin') return error('FORBIDDEN', 'Administrator required', 403);
  if (req.method !== 'POST') return error('FORBIDDEN', 'POST required', 403);
  const input = await readJson(req, path.endsWith('/repository') ? 8 * 1024 * 1024 : 256 * 1024);
  const owner = username(input.username);
  if (path.endsWith('/retry_coordinator'))
    return response(await retryCampaignCoordinator(env, owner, input));
  if (path.endsWith('/reconcile_model_limit'))
    return response(await reconcileCampaignModelLimit(env, owner, input.repo_id, input.job_id));
  if (path.endsWith('/repository')) return campaignRepository(env, owner, input);
  if (path.endsWith('/provision')) {
    const project = await provisionCampaignProject(env, principal, owner, input);
    return response(project, project.status === 'ready' ? 200 : 202);
  }
  if (path.endsWith('/start_run')) {
    const approval = input.approval;
    const repo = input.repo_id;
    const repository = await ledger(env, repo, { op: 'repository_status', _workspace: owner });
    checkLedger({ capabilities: repository.capabilities }, approval);
    const binding = await workspace(env, owner, {
      op: 'campaign_bind_run',
      ...approval.campaign,
      repo_id: repo,
      run_id: approval.id,
      model_budgets: [
        ...approval.model_budgets,
        ...(approval.repair_escalation ? [approval.repair_escalation.budget] : []),
      ],
      repair_escalation: approval.repair_escalation ?? null,
      access: 'owner',
    });
    const grant = await campaignGrant(env, owner, repo, approval, binding);
    return response(
      await ledger(env, repo, {
        ...approval,
        op: 'start_run',
        _workspace: owner,
        _campaign_grant: grant,
      }),
    );
  }
  const operations: Record<string, string> = {
    configure: 'campaign_configure',
    enable: 'campaign_enable',
    disable: 'campaign_disable',
    status: 'campaign_status',
    bind_run: 'campaign_bind_run',
    run_status: 'campaign_run_status',
  };
  const op = operations[path.slice('/api/admin/campaign/'.length)];
  if (!op) return error('NOT_FOUND', 'Unknown campaign operation', 404);
  return response(await workspace(env, owner, { ...input, op }));
}
