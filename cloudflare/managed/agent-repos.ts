// Where an agent runs: the repositories it is set up on (connected and switched on, or off
// while paused), and the sync that adds the repositories a workspace gains to agents set to run
// on all of them.
import {
  MANAGED_AGENTS,
  type ManagedAgentDefinition,
  type SyncResult,
} from '../../shared/managed-agents';
import type { ManagedEnv } from './config';
import { connect, disconnect } from './connect';
import { ledgerStub } from './ledger';
import { repoStub } from './repo-agents';
import { workspaceStub } from './workspace-agents';

/** The repositories `agent` runs on: connected and switched on (`active`) where wanted,
 * switched off elsewhere, and disconnected where no agent of the workspace is set up any more. */
export async function setRepos(
  env: ManagedEnv,
  req: Request,
  workspace: string,
  agent: ManagedAgentDefinition,
  wanted: string[],
  active: boolean,
) {
  const ws = workspaceStub(env, workspace);
  const before = (await ws.settings(agent.id)).enabled;
  for (const repo of wanted) {
    await connect(env, req, repo, workspace);
    await repoStub(env, repo).setEnabled(agent.id, active, 'workspace owner');
  }
  const removed = before.filter((r) => !wanted.includes(r));
  for (const repo of removed)
    await repoStub(env, repo).setEnabled(agent.id, false, 'workspace owner');
  await ws.setEnabled(agent.id, wanted);
  const inUse = await ws.reposInUse();
  for (const repo of removed) if (!inUse.includes(repo)) await disconnect(env, req, repo);
  if (wanted.length) await ledgerStub(env, workspace).ensureStartingCredit();
}

/** Connects, for each agent set to run on all repositories, the ones the workspace gained since
 * (created or imported); asked by the web app with the owner's session, never on a timer. */
export async function sync(
  env: ManagedEnv,
  req: Request,
  workspace: string,
  owned: { id: string }[],
): Promise<SyncResult> {
  const ws = workspaceStub(env, workspace);
  let connected = 0;
  for (const agent of MANAGED_AGENTS) {
    const meta = await ws.meta(agent.id);
    if (!meta?.all_repos) continue;
    const enabled = (await ws.settings(agent.id)).enabled;
    const added = owned.map((o) => o.id).filter((r) => !enabled.includes(r));
    if (!added.length) continue;
    await setRepos(env, req, workspace, agent, [...enabled, ...added], meta.active);
    connected += added.length;
  }
  return { connected };
}
