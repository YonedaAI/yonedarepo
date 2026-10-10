import { username } from './accounts';
import { error, readJson, response } from './http';
import { scheduleProject } from './project-provisioning';
import { reviewerPolicy } from './reviewer-policy';
import {
  resumeTrial,
  reviewerRepairFingerprint,
  reviewerTrialStatus,
  startTrial,
} from './reviewer-trial';
import { ledger, sha } from './storage';
import type { Env, Json, Principal } from './types';
import { providerCredentials, seal } from './vault';
import { workspace } from './workspace';

export async function reviewerRoute(req: Request, env: Env, principal: Principal) {
  const path = new URL(req.url).pathname;
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
  const policy = await workspace(env, principal.workspace, { op: 'reviewer_status' });
  if (path === '/api/reviewer' && req.method === 'GET') {
    return response({
      ...(await reviewerTrialStatus(env, principal.workspace)),
      budget: await workspace(env, principal.workspace, { op: 'budget_status' }),
      project: await workspace(env, principal.workspace, { op: 'project_get', id: policy.repo_id }),
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
  return error('NOT_FOUND', 'Unknown reviewer route', 404);
}

/** Restrict reviewer mutations at the server before any generic owner route runs. */
export async function reviewerGuard(req: Request, env: Env, principal: Principal) {
  if (!principal.reviewer) return null;
  const path = new URL(req.url).pathname;
  const policy = await workspace(env, principal.workspace, { op: 'reviewer_status' });
  if (policy.revoked || policy.expires <= Date.now())
    return error('UNAUTHORIZED', 'Reviewer access expired', 401);
  if (path.startsWith('/api/reviewer')) return null;
  if (req.method === 'GET') return null;
  const parts = path.split('/').filter(Boolean);
  if (parts[1] === 'repos' && parts[3] === 'repair_team') {
    if (req.method !== 'POST' || parts[2] !== policy.repo_id)
      return error('FORBIDDEN', 'Reviewer repair is limited to its trial repository', 403);
    let input: Json;
    try {
      input = await readJson(req.clone(), 256 * 1024);
    } catch {
      return error('INVALID_INPUT', 'A valid repair request is required');
    }
    const runId = input.run_id;
    if (typeof runId !== 'string' || !runId || runId.length > 200)
      return error('INVALID_INPUT', 'A reviewer trial run ID is required');
    if (typeof input.request_id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(input.request_id))
      return error('INVALID_INPUT', 'A stable repair request ID is required');
    const detail = await ledger(env, policy.repo_id, {
      op: 'run_detail',
      run_id: runId,
      _workspace: principal.workspace,
    });
    if (detail.repository?.id !== policy.repo_id || detail.run?.id !== runId)
      return error('FORBIDDEN', 'Repair must target an existing reviewer trial run', 403);
    await workspace(env, principal.workspace, {
      op: 'reviewer_trial_reopen',
      id: runId,
      request_id: input.request_id,
      fingerprint: await reviewerRepairFingerprint(input),
    });
    return null;
  }
  if (
    parts[1] === 'repos' &&
    parts[2] === policy.repo_id &&
    ['accept', 'cancel_run', 'resync_repository', 'refresh_candidate', 'resolve_conflict'].includes(
      parts[3],
    )
  )
    return null;
  return error('FORBIDDEN', 'Reviewer access permits funded trials and sandbox review only', 403);
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
