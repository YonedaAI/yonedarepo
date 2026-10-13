import { username } from './accounts';
import { error, readJson, response } from './http';
import type { Env, Json, Principal } from './types';
import { workspace } from './workspace';
import { assertWorkspaceQuiescent } from './workspace-transition';

/** All first configurations share the same fail-closed transition observation. */
export async function configureWorkspaceAllowance(
  env: Env,
  owner: string,
  expectedVersion: number,
  limit: number,
): Promise<Json> {
  const current = await workspace(env, owner, { op: 'workspace_spend_status' });
  if (!Number.isSafeInteger(current.version) || current.version < 0)
    throw Object.assign(new Error('Workspace allowance version unavailable'), {
      code: 'WORKSPACE_TRANSITION_BUSY',
    });
  if (current.version === 0) await assertWorkspaceQuiescent(env, owner);
  return workspace(env, owner, {
    op: 'workspace_spend_configure',
    expected_version: expectedVersion,
    limit_microusd: limit,
  });
}

export async function workspaceAllowanceRoute(
  req: Request,
  env: Env,
  principal: Principal,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (path === '/api/admin/workspace/allowance' && req.method === 'POST') {
    if (principal.role !== 'admin') return error('FORBIDDEN', 'Administrator required', 403);
    const input = await readJson(req);
    return response(
      await configureWorkspaceAllowance(
        env,
        username(input.username),
        input.expected_version,
        input.limit_microusd,
      ),
    );
  }
  if (path !== '/api/workspace/allowance') return null;
  if (principal.role !== 'user') return error('FORBIDDEN', 'Personal account required', 403);
  const current = await workspace(env, principal.workspace, { op: 'workspace_spend_status' });
  if (req.method === 'GET') return response(current);
  if (req.method !== 'POST')
    return error('NOT_FOUND', 'Unknown workspace allowance operation', 404);
  const input = await readJson(req);
  if (!Number.isSafeInteger(input.limit_microusd) || input.limit_microusd > current.limit_microusd)
    return error('FORBIDDEN', 'An administrator must increase the workspace allowance', 403);
  return response(
    await configureWorkspaceAllowance(
      env,
      principal.workspace,
      input.expected_version,
      input.limit_microusd,
    ),
  );
}
