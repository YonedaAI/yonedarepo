import { readJson, response } from './http';
import { ledger } from './storage';
import type { Env, Principal } from './types';
import { workspace } from './workspace';

/** The workspace projection receives ledger observations, never caller-provided authority. */
export async function changeProjectVisibility(
  req: Request,
  env: Env,
  principal: Principal,
  repo: string,
) {
  await ledger(env, repo, { op: 'repository_status', _workspace: principal.workspace });
  const input = await readJson(req);
  const receipt =
    input.hidden === true
      ? await ledger(env, repo, { op: 'project_visibility_check', _workspace: principal.workspace })
      : undefined;
  return response(
    await workspace(env, principal.workspace, {
      op: 'project_set_visibility',
      id: repo,
      _workspace: principal.workspace,
      hidden: input.hidden,
      expected_hidden: input.expected_hidden,
      reason: input.reason,
      ...(receipt ? { _visibility: receipt } : {}),
    }),
  );
}
