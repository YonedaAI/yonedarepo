import { username } from './accounts';
import { error, readJson, response } from './http';
import { ensureProjectPlatform } from './project-platform';
import { scheduleProject } from './project-provisioning';
import { reviewerManagedMiMo } from './reviewer-managed-mimo';
import { reviewerPolicy } from './reviewer-policy';
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
    // The judging window by default; tests pass their own, at most 30 days ahead.
    const expires = body.expires_at ?? Date.UTC(2026, 9, 23);
    if (
      body.expires_at !== undefined &&
      (!Number.isSafeInteger(expires) ||
        expires <= Date.now() ||
        expires > Date.now() + 30 * 24 * 60 * 60 * 1000)
    )
      return error('INVALID_INPUT', 'expires_at must be within the next 30 days');
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
    else await ensureProjectPlatform(env, req, owner, project, undefined, true);
    await scheduleProject(env, owner, project);
    return response({
      username: owner,
      repo_id: repo,
      expires: policy.expires,
      budget_microusd: policy.limit_microusd,
      status: project.status,
    });
  }
  // The funded reviewer trial was retired; reviewer accounts use ordinary Start a Run.
  return null;
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
