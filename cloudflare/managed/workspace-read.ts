// Workspace list reads: fresh platform ownership, managed state and credit stay request-owned.
import {
  type AgentState,
  MANAGED_AGENTS,
  type ManagedAgentDefinition,
} from '../../shared/managed-agents';
import { customizedFields, resolveSettings } from '../../shared/managed-settings';
import { timed } from '../worker/request-scope';
import { ApiRefusal } from './api-refusal';
import { credit } from './billing';
import { type ManagedEnv, TOKEN_NAME } from './config';
import { type Json, Platform } from './platform';
import { repoStub } from './repo-agents';
import { stripeEnabled } from './stripe';
import { workspaceStub } from './workspace-agents';

type Owned = { id: string; name: string };

/** The caller's standing in `workspace`: whether they own it, and its repositories they own. A
 * personal workspace belongs to its account from sign-up, before it has any repository. */
export async function access(caller: Platform, workspace: string, onOwner?: () => void) {
  let live = true;
  const admit = () => {
    if (live) onOwner?.();
  };
  const listing = caller.repos();
  const memberships = caller.orgs().catch(() => ({ orgs: [] as Json[] }));
  const identity = caller.session(Boolean(onOwner)).catch(() => null);
  // A fresh positive owner proof can admit read work while repository discovery finishes.
  // The complete original access decision still gates the response below.
  if (onOwner) {
    void identity
      .then((s) => {
        if (s?.authenticated === true && s.username === workspace) admit();
      })
      .catch(() => {});
    void memberships
      .then((o) => {
        if ((o.orgs as Json[]).some((r) => r.org === workspace && r.role === 'owner')) admit();
      })
      .catch(() => {});
  }
  try {
    const [listed, orgs, session] = await Promise.all([listing, memberships, identity]);
    const repos = ((listed.repos ?? []) as Json[])
      .filter((r) => r.owner === workspace && r.role === 'owner')
      .map((r) => ({ id: String(r.id), name: String(r.name) }));
    const orgOwner = ((orgs.orgs ?? []) as Json[]).some(
      (o) => o.org === workspace && o.role === 'owner',
    );
    const personal = session?.authenticated === true && session.username === workspace;
    if (!personal && !orgOwner && repos.length === 0)
      throw new ApiRefusal('FORBIDDEN', 'Only a workspace owner can manage its agents', 403);
    admit();
    return repos;
  } finally {
    live = false;
  }
}

export async function runsOf(
  env: ManagedEnv,
  repos: string[],
  agent: string | null,
  limit: number,
) {
  const lists = await Promise.all(repos.map((r) => repoStub(env, r).runs(agent, limit)));
  return lists.flat().sort((a, b) => b.created_at - a.created_at);
}

export async function agentState(
  env: ManagedEnv,
  workspace: string,
  agent: ManagedAgentDefinition,
  owned: { id: string }[] | Promise<{ id: string }[]>,
): Promise<AgentState> {
  const ws = workspaceStub(env, workspace);
  const [stored, meta] = await Promise.all([ws.settings(agent.id), ws.meta(agent.id)]);
  const runs = await runsOf(env, stored.enabled, agent.id, 200);
  const visible = await owned;
  return {
    ...agent,
    created_by: meta?.created_by ?? null,
    created_at: meta?.created_at ?? null,
    active: meta?.active ?? true,
    all_repos: meta?.all_repos ?? false,
    settings: resolveSettings(agent, stored.workspace),
    customized: customizedFields(stored.workspace),
    repo_overrides: Object.fromEntries(
      Object.entries(stored.repos)
        .map(([r, o]) => [r, customizedFields(o)] as const)
        .filter(([, fields]) => fields.length > 0),
    ),
    // A deleted repository stays stored until the next save, which a form must be able to send.
    enabled_repos: stored.enabled.filter((r) => visible.some((o) => o.id === r)),
    history: runs.slice(0, 6).map(({ id, repo, change, value, status, created_at }) => ({
      id,
      repo,
      change,
      value,
      status,
      created_at,
    })),
    runs: runs.length,
  };
}

/** Returns one complete authorized envelope. Early read work never sends a partial response. */
export async function workspaceRead(
  req: Request,
  env: ManagedEnv,
  workspace: string,
): Promise<Json> {
  const caller = new Platform(env, { forward: req });
  if (env.FAST_AGENTS_LIST !== 'on') {
    const owned = await timed('managed.access', () => access(caller, workspace));
    const agents = await timed('managed.agents', () =>
      Promise.all(MANAGED_AGENTS.map((a) => agentState(env, workspace, a, owned))),
    );
    const balance = await timed('managed.credit', () => credit(env, workspace));
    return answer(env, workspace, owned, agents, balance);
  }
  let owned: Promise<Owned[]>;
  let loading: { agents: Promise<AgentState[]>; balance: ReturnType<typeof credit> } | undefined;
  const start = () => {
    if (loading) return loading;
    loading = {
      agents: timed('managed.agents', () =>
        Promise.all(MANAGED_AGENTS.map((a) => agentState(env, workspace, a, owned))),
      ),
      balance: timed('managed.credit', () => credit(env, workspace)),
    };
    // The full access call may fail later; abandoned request-owned reads must be handled.
    void loading.agents.catch(() => {});
    void loading.balance.catch(() => {});
    return loading;
  };
  owned = timed('managed.access', () => access(caller, workspace, start));
  const repos = await owned;
  const ready = start();
  const [agents, balance] = await Promise.all([ready.agents, ready.balance]);
  return answer(env, workspace, repos, agents, balance);
}

function answer(
  env: ManagedEnv,
  workspace: string,
  repos: Owned[],
  agents: AgentState[],
  balance: Awaited<ReturnType<typeof credit>>,
) {
  return {
    workspace,
    capabilities: ['exact_head_review'],
    agents,
    credit: balance,
    billing: stripeEnabled(env) ? 'stripe' : 'coming',
    repos,
    token_name: TOKEN_NAME,
  };
}
