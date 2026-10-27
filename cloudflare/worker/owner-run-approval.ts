import { runSamples } from '../../shared/run-samples';
import { freezeSourceApproval } from './api-source-approval';
import { resolveFixedApproval } from './fixed-run-approval';
import { resolveRunRoster } from './run-roster';
import { checkLedger } from './runtime';
import { ledger } from './storage';
import type { Env, Json, Principal } from './types';
import { providerCredentials } from './vault';
import { workspace } from './workspace';
import { configureWorkspaceAllowance } from './workspace-allowance-route';
import { validateWorkspaceSpendRun } from './workspace-spend';

const invalid = (message: string) => Object.assign(new Error(message), { code: 'INVALID_INPUT' });

/** Credentials and normalized compatibility are checked before first funding activation. */
export async function approveOwnerRun(
  env: Env,
  principal: Principal,
  repo: string,
  input: Json,
): Promise<Json> {
  const repository = await ledger(env, repo, {
    op: 'repository_status',
    _workspace: principal.workspace,
  });
  checkLedger(repository, input);
  if (principal.role !== 'user') {
    await freezeSourceApproval(env, principal.workspace, repo, input, repository);
    return input;
  }
  if (
    typeof input.id !== 'string' ||
    !input.id ||
    typeof input.intent !== 'string' ||
    !input.intent.trim()
  )
    throw invalid('A run ID and brief are required.');
  if (input.sample_profile_id !== undefined) {
    const sample = runSamples.find((sample) => sample.id === input.sample_profile_id);
    if (!sample) throw invalid('Unknown sample run profile');
    input._sample_profile = {
      id: sample.id,
      version: sample.version,
      evidence_targets: sample.evidence_targets,
    };
  }
  const settings = await workspace(env, principal.workspace, { op: 'settings' });
  let allowance = await workspace(env, principal.workspace, { op: 'workspace_spend_status' });
  if (
    !Number.isSafeInteger(allowance.version) ||
    allowance.version < 0 ||
    !Number.isSafeInteger(allowance.limit_microusd) ||
    allowance.limit_microusd <= 0
  )
    throw invalid('The workspace allowance is unavailable.');
  if (!Number.isSafeInteger(allowance.remaining_microusd) || allowance.remaining_microusd <= 0)
    throw Object.assign(new Error('The workspace allowance is exhausted'), {
      code: 'WORKSPACE_SPEND_LIMIT',
    });
  const resolve = (limit: number) =>
    input.adaptive_team !== undefined
      ? resolveRunRoster(input, settings.providers, limit)
      : resolveFixedApproval(input, settings.providers, limit);
  let approved = resolve(allowance.limit_microusd);
  validateWorkspaceSpendRun(approved);
  checkLedger(repository, approved);
  const checked = new Set<string>();
  for (const agent of approved.agents) {
    const id = agent.connection ?? agent.provider;
    const connection = settings.providers.find(
      (entry: Json) =>
        entry.id === id && entry.provider === agent.provider && entry.model === agent.model,
    );
    if (!connection)
      throw Object.assign(new Error('Selected saved model changed'), { code: 'PROVIDER_MISSING' });
    delete agent.routing;
    if (connection.routing != null) agent.routing = connection.routing;
    if (checked.has(id)) continue;
    try {
      await providerCredentials(
        env,
        principal.workspace,
        agent.provider,
        id,
        agent.model,
        agent.routing,
      );
    } catch {
      throw Object.assign(new Error('A saved provider connection is unavailable or has changed'), {
        code: 'PROVIDER_MISSING',
      });
    }
    checked.add(id);
  }
  // Source is read back only for a credentialed start, before funding activation.
  await freezeSourceApproval(env, principal.workspace, repo, input, repository);
  approved = resolve(allowance.limit_microusd);
  validateWorkspaceSpendRun(approved);
  // Recheck after saved routing and every generated marker/budget have been normalized.
  checkLedger(repository, approved);
  if (allowance.version === 0) {
    try {
      allowance = await configureWorkspaceAllowance(
        env,
        principal.workspace,
        0,
        allowance.limit_microusd,
      );
    } catch (failure) {
      // Recover only a successful concurrent CAS, never a failed quiescence or other error.
      if ((failure as { code?: string }).code !== 'STALE_VERSION') throw failure;
      allowance = await workspace(env, principal.workspace, { op: 'workspace_spend_status' });
      if (!Number.isSafeInteger(allowance.version) || allowance.version < 1) throw failure;
    }
    approved = resolve(allowance.limit_microusd);
    validateWorkspaceSpendRun(approved);
    checkLedger(repository, approved);
  }
  if (allowance.remaining_microusd <= 0)
    throw Object.assign(new Error('The workspace allowance is exhausted'), {
      code: 'WORKSPACE_SPEND_LIMIT',
    });
  return approved;
}
