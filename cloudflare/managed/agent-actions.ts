// Agent actions beyond settings: Run now (review every open change of the agent's
// repositories at its head, once per head), a repository's Agents page rows, and the name the
// set-up is recorded under.
import {
  MANAGED_AGENTS,
  type ManagedAgentDefinition,
  type RepoAgentRow,
  type RunNowResult,
} from '../../shared/managed-agents';
import { resolveSettings } from '../../shared/managed-settings';
import type { ManagedEnv } from './config';
import { reviewChanges } from './dispatch';
import { Platform } from './platform';
import { repoStub } from './repo-agents';
import { workspaceStub } from './workspace-agents';

/** Who is setting an agent up, as the platform names the caller (`user:<name>` → `<name>`). With
 * no repository to ask about, a personal workspace's owner is its account; an org's is named by
 * the org. */
export async function principalName(caller: Platform, owned: { id: string }[], workspace: string) {
  if (!owned.length) {
    const orgs = ((await caller.orgs().catch(() => ({ orgs: [] }))).orgs ?? []) as {
      org: string;
    }[];
    return orgs.some((o) => o.org === workspace) ? `an owner of ${workspace}` : workspace;
  }
  const status = await caller.status(owned[0].id).catch(() => null);
  const principal = String(status?.viewer?.principal ?? 'workspace owner');
  return principal.startsWith('user:') ? principal.slice('user:'.length) : principal;
}

/** Run now: open changes of each of the agent's repositories, reviewed at their heads. */
export async function runNow(
  env: ManagedEnv,
  workspace: string,
  agent: ManagedAgentDefinition,
): Promise<RunNowResult> {
  const ws = workspaceStub(env, workspace);
  const total: RunNowResult = { started: 0, already: 0 };
  if (!(await ws.meta(agent.id))?.active) return total;
  for (const repo of (await ws.settings(agent.id)).enabled) {
    const connection = await repoStub(env, repo)
      .connection()
      .catch(() => null);
    if (!connection || connection.revoked) continue;
    const platform = new Platform(env, { token: connection.token });
    if (await platform.automationPaused(repo)) continue;
    const open = ((await platform.openChanges(repo)).changes ?? []) as Record<string, any>[];
    const counts = await reviewChanges(
      env,
      repo,
      { account: workspace, platform },
      [agent.id],
      open.filter((c) => typeof c.head === 'string'),
      true,
    );
    total.started += counts.started;
    total.already += counts.already;
  }
  return total;
}

/** A repository's Agents page: each agent's status there, harness and model, latest review. */
export async function repoAgents(
  env: ManagedEnv,
  workspace: string,
  repo: string,
): Promise<RepoAgentRow[]> {
  const ws = workspaceStub(env, workspace);
  const stub = repoStub(env, repo);
  return Promise.all(
    MANAGED_AGENTS.map(async (agent) => {
      const [stored, meta, latest] = await Promise.all([
        ws.settings(agent.id),
        ws.meta(agent.id),
        stub.runs(agent.id, 1),
      ]);
      const s = resolveSettings(agent, stored.workspace, stored.repos[repo]);
      const on = stored.enabled.includes(repo);
      const run = latest[0];
      return {
        id: agent.id,
        name: s.name,
        status: on ? (meta?.active === false ? 'paused' : 'active') : 'off',
        harness: s.harness,
        model: s.model,
        latest: run
          ? {
              id: run.id,
              repo: run.repo,
              change: run.change,
              value: run.value,
              status: run.status,
              created_at: run.created_at,
            }
          : null,
      } satisfies RepoAgentRow;
    }),
  );
}
