import { username } from './accounts';
import { error, readJson, response } from './http';
import { ensureProjectPlatform, projectSeed } from './project-platform';
import { scheduleProject } from './project-provisioning';
import { ownerCommandInput } from './repository-command';
import { reviewerCampaignStatus } from './reviewer-campaign';
import { reviewerManagedMiMo } from './reviewer-managed-mimo';
import { reviewerPolicy } from './reviewer-policy';
import {
  resumeTrial,
  reviewerRepairFingerprint,
  reviewerTrialStatus,
  startTrial,
  submitReviewerRepair,
} from './reviewer-trial';
import { ledger, sha } from './storage';
import type { Env, Principal } from './types';
import { providerCredentials, seal } from './vault';
import { workspace } from './workspace';

export async function reviewerRoute(req: Request, env: Env, principal: Principal) {
  const path = new URL(req.url).pathname;
  if (path === '/api/admin/reviewer/managed-mimo') return reviewerManagedMiMo(req, env, principal);
  if (path.startsWith('/api/admin/reviewer/')) {
    if (principal.role !== 'admin') return error('FORBIDDEN', 'Administrator required', 403);
    const body = await readJson(req);
    const owner = username(body.username);
    if (path.endsWith('/revoke') && req.method === 'POST')
      return response(await workspace(env, owner, { op: 'reviewer_revoke' }));
    if (path.endsWith('/recheck') && req.method === 'POST') {
      const configured = await workspace(env, owner, { op: 'reviewer_status' });
      return response(await configureReviewPolicy(env, owner, configured.repo_id));
    }
    if (!path.endsWith('/provision') || req.method !== 'POST')
      return error('NOT_FOUND', 'Unknown reviewer operation', 404);
    const repo = `reviewer-${(await sha(owner)).slice(0, 24)}`;
    const expires = Date.UTC(2026, 9, 23);
    const policy = await workspace(env, owner, {
      op: 'reviewer_configure',
      repo_id: repo,
      expires,
    });
    for (const [provider, model] of [
      ['codex', 'gpt-5.6-luna'],
      ['claude', 'claude-sonnet-5-5'],
    ]) {
      // Preserve legacy connections so an already-approved attempt keeps its model.
      const connection =
        provider === 'claude' ? 'reviewer-claude-sonnet-5-5' : `reviewer-${provider}`;
      const { key } = await providerCredentials(env, '_admin', provider);
      await workspace(env, owner, {
        op: 'provider_put',
        provider,
        model,
        connection,
        label: `Funded ${provider}`,
        sealed: await seal(env, owner, provider, key, connection),
      });
    }
    let initialPolicy = reviewerPolicy;
    try {
      // Preserve the original provisioning receipt when upgrading check policy.
      const existing = await workspace(env, owner, { op: 'project_get', id: repo });
      initialPolicy = existing.policy;
    } catch (failure: any) {
      if (failure.code !== 'NOT_FOUND') throw failure;
    }
    const project = await workspace(env, owner, {
      op: 'project_reserve',
      id: repo,
      name: 'Reviewer sandbox',
      source: null,
      policy: initialPolicy,
    });
    if (project.status === 'ready') await configureReviewPolicy(env, owner, repo);
    // The operator creates the reviewer's platform repository on their behalf.
    else
      await ensureProjectPlatform(env, req, owner, project, await projectSeed(env, project), true);
    await scheduleProject(env, owner, project);
    return response({
      username: owner,
      repo_id: repo,
      expires: policy.expires,
      budget_microusd: policy.limit_microusd,
      status: project.status,
    });
  }
  if (!path.startsWith('/api/reviewer')) return null;
  if (!principal.reviewer) return error('FORBIDDEN', 'Reviewer account required', 403);
  if (
    req.method === 'POST' &&
    ['/api/reviewer/trial', '/api/reviewer/resume', '/api/reviewer/repair'].includes(path) &&
    (await workspace(env, principal.workspace, { op: 'workspace_spend_status' })).version >= 1
  )
    return error('WORKSPACE_WORKFLOW_UPDATED', 'Use ordinary Start a Run for this workspace', 409);
  const policy = await workspace(env, principal.workspace, { op: 'reviewer_status' });
  if (path === '/api/reviewer' && req.method === 'GET') {
    return response({
      ...(await reviewerTrialStatus(env, principal.workspace)),
      budget: await workspace(env, principal.workspace, { op: 'budget_status' }),
      project: await workspace(env, principal.workspace, { op: 'project_get', id: policy.repo_id }),
      campaign: await reviewerCampaignStatus(env, principal.workspace),
    });
  }
  if (path === '/api/reviewer/trial' && req.method === 'POST') {
    const body = await readJson(req);
    if (typeof body.request_id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(body.request_id))
      return error('INVALID_INPUT', 'A stable request ID is required');
    return response(await startTrial(env, principal.workspace, body.request_id));
  }
  if (path === '/api/reviewer/resume' && req.method === 'POST')
    return response(await resumeTrial(env, principal.workspace));
  if (path === '/api/reviewer/repair' && req.method === 'POST') {
    const input = await ownerCommandInput(req, 'repair_team');
    if (typeof input.run_id !== 'string' || !input.run_id || input.run_id.length > 200)
      return error('INVALID_INPUT', 'A reviewer trial run ID is required');
    if (typeof input.request_id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(input.request_id))
      return error('INVALID_INPUT', 'A stable repair request ID is required');
    const detail = await ledger(env, policy.repo_id, {
      op: 'run_detail',
      run_id: input.run_id,
      _workspace: principal.workspace,
    });
    if (detail.repository?.id !== policy.repo_id || detail.run?.id !== input.run_id)
      return error('FORBIDDEN', 'Repair must target an existing reviewer trial run', 403);
    await workspace(env, principal.workspace, {
      op: 'reviewer_trial_reopen',
      id: input.run_id,
      request_id: input.request_id,
      fingerprint: await reviewerRepairFingerprint(input),
    });
    return response(
      await submitReviewerRepair(env, principal.workspace, policy.repo_id, {
        ...input,
        op: 'repair_team',
        _workspace: principal.workspace,
      }),
    );
  }
  return error('NOT_FOUND', 'Unknown reviewer route', 404);
}

/** Reviewer login retains expiry/revocation; owner operations use ordinary authorization. */
export async function reviewerGuard(_req: Request, env: Env, principal: Principal) {
  if (!principal.reviewer) return null;
  const policy = await workspace(env, principal.workspace, { op: 'reviewer_status' });
  if (!policy || policy.revoked || policy.expires <= Date.now())
    return error('UNAUTHORIZED', 'Reviewer access expired', 401);
  return null;
}

/** Operator-only callers select the fixed profile; client policy and repo fields are ignored. */
async function configureReviewPolicy(env: Env, owner: string, repo: string) {
  const current = await ledger(env, repo, { op: 'repository_status', _workspace: owner });
  return ledger(env, repo, {
    op: 'update_policy',
    _workspace: owner,
    expected_commit: current.head_commit,
    expected_version: current.version,
    expected_policy: current.policy.version,
    policy: reviewerPolicy,
  });
}
