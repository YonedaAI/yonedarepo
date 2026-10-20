import {
  campaignInput,
  canonical,
  freezeReceipt,
  normalizedPolicy,
  readReceipt,
} from './campaign-provision-receipt';
import { pendingSetup, setupCode, setupError } from './project-remote';
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
function assertRepository(value: Json, request: Json, source: Json) {
  if (
    value.id !== request.repo_id ||
    value.workspace !== request.owner ||
    value.status === 'deleted' ||
    canonical(value.remote) !==
      canonical({ namespace: source.namespace, name: request.repo_id, branch: source.branch }) ||
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
async function target(env: Env, id: string) {
  try {
    return await env.ARTIFACTS.get(id);
  } catch (error) {
    if (setupCode(error) === 'NOT_FOUND') return null;
    throw error;
  }
}
async function head(repo: ArtifactsRepo, name: string) {
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
  return { info, commit: commit as string };
}
async function fork(env: Env, request: Json, source: Json) {
  using existing = await target(env, request.repo_id);
  if (!existing) {
    using starter = await env.ARTIFACTS.get(request.template);
    const current = await head(starter, request.template);
    if (current.commit !== source.commit || current.info.defaultBranch !== source.branch)
      throw setupError(
        'IDEMPOTENCY_CONFLICT',
        'Template HEAD changed after provisioning was frozen',
      );
    try {
      const created = await starter.fork(request.repo_id, {
        defaultBranchOnly: true,
        readOnly: false,
        description: 'Private YonedaRepo campaign project',
      });
      using createdRepo = await env.ARTIFACTS.get(request.repo_id);
      await createdRepo.revokeToken(created.token);
    } catch (error) {
      if (pendingSetup(error)) throw error;
      // Reconcile acknowledgment loss only against the exact frozen fork below.
      using recovered = await target(env, request.repo_id);
      if (!recovered) throw error;
    }
  }
  using remote = await env.ARTIFACTS.get(request.repo_id);
  const actual = await head(remote, request.repo_id);
  if (
    actual.info.source !== `artifacts:${source.namespace}/${source.name}` ||
    actual.info.readOnly !== false ||
    actual.info.defaultBranch !== source.branch ||
    actual.commit !== source.commit
  )
    throw setupError(
      'IDEMPOTENCY_CONFLICT',
      'Existing Artifacts target is not the frozen private starter fork',
    );
  for (const token of (await remote.listTokens()).tokens)
    if (token.state === 'active') await remote.revokeToken(token.id);
}

/** Administrator-only: no provider calls, public import, account creation or campaign activation. */
export async function provisionCampaignProject(
  env: Env,
  principal: Principal,
  owner: string,
  input: Json,
): Promise<Json> {
  if (principal.role !== 'admin') throw setupError('FORBIDDEN', 'Administrator required');
  try {
    return await provision(env, owner, input);
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
async function provision(env: Env, owner: string, input: Json): Promise<Json> {
  const request = campaignInput(owner, input);
  const reviewer = await workspace(env, owner, { op: 'reviewer_status' });
  if (!reviewer || reviewer.revoked || reviewer.expires <= Date.now())
    throw setupError('FORBIDDEN', 'Existing active reviewer workspace required');
  let receipt = await readReceipt(env, request);
  let current = await repository(env, request.repo_id);
  if (!receipt) {
    if (current)
      throw setupError('IDEMPOTENCY_CONFLICT', 'Campaign project must be a fresh repository');
    using existing = await target(env, request.repo_id);
    if (existing)
      throw setupError(
        'IDEMPOTENCY_CONFLICT',
        'Artifacts target already exists without a provisioning receipt',
      );
    using starter = await env.ARTIFACTS.get(request.template);
    const trusted = await head(starter, request.template);
    receipt = await freezeReceipt(env, request, {
      namespace: env.ARTIFACTS_NAMESPACE,
      name: request.template,
      branch: trusted.info.defaultBranch,
      commit: trusted.commit,
    });
  }
  const source = receipt.source;
  if (!current) {
    try {
      current = await ledger(env, request.repo_id, {
        op: 'init',
        id: request.repo_id,
        name: request.repo_id,
        workspace: owner,
        commit: source.commit,
        remote: { namespace: source.namespace, name: request.repo_id, branch: source.branch },
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
  assertRepository(current, request, source);
  const result = (status: string) => ({
    username: owner,
    repo_id: request.repo_id,
    status,
    commit: source.commit,
    source,
  });
  // Completed replay preserves later commits/tokens, but rechecks immutable policy/ownership.
  try {
    const project = await workspace(env, owner, { op: 'project_get', id: request.repo_id });
    if (project.status === 'deleted')
      throw setupError('REPOSITORY_DELETED', 'Campaign project was deleted');
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
  } catch (error) {
    if (setupCode(error) !== 'NOT_FOUND') throw error;
  }
  if (current.version !== 0 || current.head_commit !== source.commit)
    throw setupError(
      'IDEMPOTENCY_CONFLICT',
      'Unfinished provisioning target advanced beyond its frozen source',
    );
  try {
    await fork(env, request, source);
  } catch (error) {
    if (pendingSetup(error)) return result('provisioning');
    // Never propagate SDK error text that might contain an initial capability.
    if (['IDEMPOTENCY_CONFLICT', 'EMPTY_REPOSITORY', 'INVALID_INPUT'].includes(setupCode(error)))
      throw error;
    throw setupError('SETUP_FAILED', 'Private campaign fork unavailable; retry the same request');
  }
  await workspace(env, owner, {
    op: 'project_reserve',
    id: request.repo_id,
    name: request.repo_id,
    source: null,
    policy: request.policy,
  });
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
