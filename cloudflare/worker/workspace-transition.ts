import { safeId } from './http';
import { ledger } from './storage';
import type { Env, Json } from './types';
import { workspace } from './workspace';

const busy = () =>
  Object.assign(
    new Error('Workspace transition requires verified idle repositories and completed setup'),
    {
      code: 'WORKSPACE_TRANSITION_BUSY',
    },
  );

/**
 * Read-only observation of the authoritative inventory and each ready repository.
 * This is not a cross-DO lock: a project or run can start after its observation.
 * Callers must also retain the configured-allowance legacy egress guard.
 * Hidden projects are included; older workspace binaries without that contract fail closed.
 */
export async function assertWorkspaceQuiescent(env: Env, owner: string): Promise<void> {
  try {
    const inventory = await workspace(env, owner, { op: 'projects', include_hidden: true });
    if (
      inventory.includes_hidden !== true ||
      !Array.isArray(inventory.projects) ||
      inventory.projects.length > 100
    )
      throw busy();
    const ids = new Set<string>();
    for (const project of inventory.projects) {
      if (
        !project ||
        typeof project.id !== 'string' ||
        !safeId(project.id) ||
        project.status !== 'ready' ||
        ids.has(project.id)
      )
        throw busy();
      ids.add(project.id);
    }
    await Promise.all(
      [...ids].map(async (repo) => {
        const receipt: Json = await ledger(env, repo, {
          op: 'project_visibility_check',
          _workspace: owner,
        });
        if (receipt.repo_id !== repo || receipt.workspace !== owner || receipt.quiescent !== true)
          throw busy();
      }),
    );
  } catch {
    // No transport errors, repository data or caller input enter the public diagnostic.
    throw busy();
  }
}
