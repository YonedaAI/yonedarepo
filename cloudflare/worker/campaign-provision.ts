import { PLATFORM_NAMESPACE } from './agents-platform';
import {
  campaignInput,
  canonical,
  freezeReceipt,
  normalizedPolicy,
  readReceipt,
} from './campaign-provision-receipt';
import { ensureProjectPlatform, platformHead } from './project-platform';
import { setupCode, setupError } from './project-remote';
import { ledger } from './storage';
import type { Env, Json, Principal } from './types';
import { workspace } from './workspace';

async function repository(env: Env, id: string): Promise<Json | null> {
  try {
    return await ledger(env, id, { op: 'repository_status' });
  } catch (error) {
    if (setupCode(error) === 'NOT_FOUND') return null;
    throw error;
  }
}
function assertRepository(value: Json, request: Json) {
  if (
    value.id !== request.repo_id ||
    value.workspace !== request.owner ||
    value.status === 'deleted' ||
    canonical(value.remote) !==
      canonical({ namespace: PLATFORM_NAMESPACE, name: request.repo_id, branch: 'main' }) ||
    canonical(value.policy) !== canonical(normalizedPolicy(request.policy))
  )
    throw setupError(
      'IDEMPOTENCY_CONFLICT',
      'Repository authority differs from provisioning receipt',
    );
  const study = (input: Json | undefined) =>
    input ? { id: input.id, case: input.case, arm: input.arm, corpus: input.corpus } : null;
  if (canonical(study(value.context_study)) !== canonical(study(request.context_study)))
    throw setupError(
      'IDEMPOTENCY_CONFLICT',
      'Study configuration differs from provisioning receipt',
    );
}
async function templateHead(env: Env, name: string) {
  using repo = await env.ARTIFACTS.get(name);
  const info = await repo.info();
  if (
    info.name !== name ||
    typeof info.defaultBranch !== 'string' ||
    !info.defaultBranch ||
    info.defaultBranch.length > 255
  )
    throw setupError('INVALID_INPUT', 'Artifacts repository metadata differs from requested name');
  const commit = (await repo.log({ ref: info.defaultBranch, limit: 1 }))[0]?.hash;
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit ?? ''))
    throw setupError('EMPTY_REPOSITORY', 'Template requires a valid default-branch commit');
  return { branch: info.defaultBranch, commit: commit as string };
}

/** Administrator-only: no provider calls, public import, account creation or campaign activation. */
export async function provisionCampaignProject(
  env: Env,
  req: Request,
  principal: Principal,
  owner: string,
  input: Json,
): Promise<Json> {
  if (principal.role !== 'admin') throw setupError('FORBIDDEN', 'Administrator required');
  try {
    return await provision(env, req, owner, input);
  } catch (error) {
    const messages: Record<string, string> = {
      FORBIDDEN: 'Existing active reviewer workspace required',
      INVALID_INPUT: 'Invalid frozen campaign provisioning input',
      IDEMPOTENCY_CONFLICT:
        'Repository provisioning differs from frozen input or existing authority',
      REPOSITORY_DELETED: 'Campaign project was deleted',
      EMPTY_REPOSITORY: 'Template requires a valid default-branch commit',
      LEDGER_UPDATING: 'Repository ledger is updating; retry the same request',
      FENCED: 'Project setup lease changed; retry the same request',
    };
    const code = setupCode(error);
    throw setupError(
      messages[code] ? code : 'SETUP_FAILED',
      messages[code] ?? 'Private campaign provisioning unavailable; retry the same request',
    );
  }
}
async function provision(env: Env, req: Request, owner: string, input: Json): Promise<Json> {
  const request = campaignInput(owner, input);
  const reviewer = await workspace(env, owner, { op: 'reviewer_status' });
  if (!reviewer || reviewer.revoked || reviewer.expires <= Date.now())
    throw setupError('FORBIDDEN', 'Existing active reviewer workspace required');
  let receipt = await readReceipt(env, request);
  let current = await repository(env, request.repo_id);
  if (!receipt) {
    if (current)
      throw setupError('IDEMPOTENCY_CONFLICT', 'Campaign project must be a fresh repository');
    const trusted = await templateHead(env, request.template);
    receipt = await freezeReceipt(env, request, {
      namespace: env.ARTIFACTS_NAMESPACE,
      name: request.template,
      branch: trusted.branch,
      commit: trusted.commit,
    });
  }
  const source = receipt.source;
  const result = (status: string) => ({
    username: owner,
    repo_id: request.repo_id,
    status,
    commit: source.commit,
    source,
  });
  const project = await workspace(env, owner, {
    op: 'project_reserve',
    id: request.repo_id,
    name: request.repo_id,
    source: null,
    policy: request.policy,
  });
  if (project.status === 'deleted')
    throw setupError('REPOSITORY_DELETED', 'Campaign project was deleted');
  // The operator seeds the reviewer's private platform repository from the frozen template.
  await ensureProjectPlatform(
    env,
    req,
    owner,
    project,
    { template: request.template, commit: source.commit },
    true,
  );
  if (!current) {
    const { platform, head } = await platformHead(env, owner, project);
    const seeded = await platform.call('GET', `/commits/${head}`);
    try {
      current = await ledger(env, request.repo_id, {
        op: 'init',
        id: request.repo_id,
        name: request.repo_id,
        workspace: owner,
        commit: head,
        tree: seeded.tree,
        platform_repo: platform.repo,
        remote: { namespace: PLATFORM_NAMESPACE, name: request.repo_id, branch: 'main' },
        policy: request.policy,
        ...(request.context_study !== undefined ? { context_study: request.context_study } : {}),
        ...(request.context_seed !== undefined ? { context_seed: request.context_seed } : {}),
      });
    } catch (error) {
      if (setupCode(error) !== 'ALREADY_EXISTS') throw error;
      current = await repository(env, request.repo_id);
    }
  }
  if (!current) throw setupError('SETUP_FAILED', 'Repository initialization unavailable');
  assertRepository(current, request);
  if (project.status === 'ready') {
    if (
      canonical(project.policy) !== canonical(request.policy) ||
      project.source !== null ||
      project.name !== request.repo_id
    )
      throw setupError(
        'IDEMPOTENCY_CONFLICT',
        'Workspace project differs from its provisioning receipt',
      );
    return result('ready');
  }
  const claimed = await workspace(env, owner, { op: 'project_claim', id: request.repo_id });
  if (claimed.status === 'ready') return result('ready');
  if (!claimed.claimed) return result('provisioning');
  await workspace(env, owner, {
    op: 'project_update',
    id: request.repo_id,
    epoch: claimed.setup_epoch,
    status: 'ready',
  });
  return result('ready');
}
