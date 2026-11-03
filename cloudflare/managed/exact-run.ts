// An owner's explicit review request names one current head. Trigger filters control automatic
// discovery; a manual request still obeys enablement, draft and automation-pause policy.
import type { ManagedAgentDefinition } from '../../shared/managed-agents';
import { COMMIT_ID, type ManagedEnv, REPO_ID } from './config';
import { reviewable, reviewChanges } from './dispatch';
import { Platform, PlatformError } from './platform';
import { repoStub } from './repo-agents';
import { workspaceStub } from './workspace-agents';

export async function runExact(
  env: ManagedEnv,
  workspace: string,
  agent: ManagedAgentDefinition,
  owned: { id: string }[],
  body: Record<string, unknown>,
) {
  const { repo, change, head } = body;
  if (
    Object.keys(body).some((key) => !['repo', 'change', 'head'].includes(key)) ||
    typeof repo !== 'string' ||
    !REPO_ID.test(repo) ||
    !Number.isSafeInteger(change) ||
    Number(change) < 1 ||
    typeof head !== 'string' ||
    !COMMIT_ID.test(head)
  )
    throw new PlatformError('INVALID_INPUT', 'Name a repository, change and exact head', 400);
  if (!owned.some((r) => r.id === repo))
    throw new PlatformError('FORBIDDEN', 'That repository is not one you own here', 403);
  const ws = workspaceStub(env, workspace);
  if (!(await ws.meta(agent.id))?.active || !(await ws.settings(agent.id)).enabled.includes(repo))
    throw new PlatformError('FORBIDDEN', 'Enable this agent on the repository first', 403);
  const connection = await repoStub(env, repo).connection();
  if (!connection || connection.revoked || connection.account !== workspace)
    throw new PlatformError('FORBIDDEN', 'The repository agent connection is not active', 403);
  const platform = new Platform(env, { token: connection.token });
  const current = (await reviewable(platform, repo)).find((c) => c.number === change);
  if (!current || current.head !== head)
    throw new PlatformError(
      'STALE_HEAD',
      'The requested change is no longer open at that head',
      409,
    );
  const { started, already } = await reviewChanges(
    env,
    repo,
    { account: workspace, platform },
    [agent.id],
    [current],
    true,
    1,
    false,
    true,
  );
  return { started, already };
}
