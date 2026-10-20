import { AGENT_TOKEN, platformRequest } from './agents-platform';
import { readJson, response } from './http';
import { writeLog } from './logging';
import { ledger } from './storage';
import type { Env, Json, Principal } from './types';
import { workspace } from './workspace';

export async function deleteRepository(req: Request, env: Env, principal: Principal, id: string) {
  const { confirm_name } = await readJson(req);
  const project =
    principal.role === 'user'
      ? await workspace(env, principal.workspace, { op: 'project_get', id })
      : undefined;
  let result: Json;
  try {
    result = await ledger(env, id, {
      op: 'delete_repository',
      id,
      confirm_name,
      _workspace: principal.workspace,
      ...(project ? { project } : {}),
    });
  } catch (cause) {
    // Worker and DO code propagate independently; never report a missing product action.
    if (cause instanceof Error && cause.message === 'Unknown repository operation')
      throw Object.assign(
        new Error('Repository code is still updating. Try deletion again shortly.'),
        {
          code: 'LEDGER_UPDATING',
        },
      );
    throw cause;
  }
  // The Repo DO outbox also retries this projection if the request loses its acknowledgment.
  if (principal.role === 'user') {
    if (project?.platform?.repo) await revokeAgentToken(env, req, id, project.platform.repo);
    try {
      await workspace(env, principal.workspace, { op: 'project_delete', id });
    } catch {
      writeLog('repository.cleanup_deferred', { repo_id: id });
    }
  }
  writeLog('repository.deleted', { repo_id: id });
  return response(result);
}

/**
 * The deleted project's agent token stops working, revoked with the owner's own credential.
 * The platform repository itself stays with its owner, who manages it on the platform.
 */
async function revokeAgentToken(env: Env, owner: Request, id: string, repo: string) {
  try {
    await platformRequest(
      env,
      { forward: owner },
      'DELETE',
      `/repos/${repo}/tokens/${AGENT_TOKEN}`,
    );
  } catch {
    writeLog('repository.token_revocation_deferred', { repo_id: id });
  }
}

export async function deliverDeletion(env: Env, repo: string, entry: Json) {
  if (entry.kind === 'workspace_delete') {
    if (entry.payload.repo_id !== repo) throw new Error('Deletion identity mismatch');
    await workspace(env, entry.payload.workspace, { op: 'project_delete', id: repo });
  } else {
    // Drains Artifacts cleanup recorded before projects moved to the platform.
    await env.ARTIFACTS.delete(entry.payload.name);
  }
}
