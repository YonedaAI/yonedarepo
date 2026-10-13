import { deriveComparisonReviewer } from './comparison-approval';
import { error, response } from './http';
import { ownerCommandInput } from './repository-command';
import { checkLedger } from './runtime';
import { ledger } from './storage';
import type { Env, Json, Principal } from './types';
import { providerCredentials } from './vault';
import { workspace } from './workspace';
import { configureWorkspaceAllowance } from './workspace-allowance-route';

/** Owner approval/select adapters never publish and never trust browser model identities. */
export async function comparisonOwnerRoute(
  req: Request,
  env: Env,
  principal: Principal,
  repo: string,
  action: string,
): Promise<Response> {
  if (
    req.method !== 'POST' ||
    !['approve_comparison_review', 'select_comparison_candidate'].includes(action)
  )
    return error('NOT_FOUND', 'Unknown comparison operation', 404);
  if (principal.role !== 'user') return error('FORBIDDEN', 'Use the owning personal account', 403);
  const input = await ownerCommandInput(req, action);
  const repository = await ledger(env, repo, {
    op: 'repository_status',
    _workspace: principal.workspace,
  });
  checkLedger(repository, { op: action });
  let trusted: Json = {};
  if (action === 'approve_comparison_review') {
    const detail = await ledger(env, repo, {
      op: 'run_detail',
      run_id: input.run_id,
      _workspace: principal.workspace,
    });
    const settings = await workspace(env, principal.workspace, { op: 'settings' });
    let allowance = await workspace(env, principal.workspace, { op: 'workspace_spend_status' });
    if (
      !Number.isSafeInteger(allowance.version) ||
      allowance.version < 0 ||
      !Number.isSafeInteger(allowance.limit_microusd) ||
      allowance.limit_microusd <= 0 ||
      allowance.remaining_microusd <= 0
    )
      return error(
        'WORKSPACE_SPEND_LIMIT',
        'The workspace allowance is unavailable or exhausted',
        409,
      );
    trusted = deriveComparisonReviewer(settings.providers, allowance.limit_microusd);
    for (const agent of [...(detail.run?.agents ?? []), trusted._comparison_reviewer]) {
      const saved = settings.providers.find(
        (entry: Json) => entry.id === (agent.connection ?? agent.provider),
      );
      if (
        !saved ||
        saved.provider !== agent.provider ||
        saved.model !== agent.model ||
        (agent.version != null && saved.version !== agent.version)
      )
        return error(
          'PROVIDER_MISSING',
          'An approved saved model changed; refresh Connect Agents',
          409,
        );
      try {
        await providerCredentials(
          env,
          principal.workspace,
          agent.provider,
          agent.connection,
          agent.model,
          agent.routing,
          agent.version,
        );
      } catch {
        return error(
          'PROVIDER_MISSING',
          'An approved saved model is unavailable; refresh Connect Agents',
          409,
        );
      }
    }
    if (allowance.version === 0)
      allowance = await configureWorkspaceAllowance(
        env,
        principal.workspace,
        0,
        allowance.limit_microusd,
      );
    if (allowance.remaining_microusd <= 0)
      return error('WORKSPACE_SPEND_LIMIT', 'The workspace allowance is exhausted', 409);
  }
  return response(
    await ledger(env, repo, { ...input, ...trusted, op: action, _workspace: principal.workspace }),
  );
}
