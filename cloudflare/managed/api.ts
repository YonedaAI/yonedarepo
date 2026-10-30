// The browser's `/api/managed/*`, reached through the front Worker on the site's own origin and
// scoped to a workspace (a personal account or an org). The platform authorizes every request
// with the caller's own credential: only a workspace owner (who can mint repository tokens and
// register webhooks) sees or changes its agents, runs and billing. The workspace is the billed
// account.

import { isCanonicalAccountIdentifier } from '../../shared/account';
import {
  type AgentState,
  MANAGED_AGENTS,
  type ManagedAgentDefinition,
  type ManagedAgentId,
  type ManagedCredit,
  STARTING_CREDIT_USD,
} from '../../shared/managed-agents';
import {
  customizedFields,
  resolveSettings,
  SettingsError,
  validateOverrides,
} from '../../shared/managed-settings';
import { HOOK_EVENTS, type ManagedEnv, REPO_ID, TOKEN_NAME, TOKEN_SCOPES } from './config';
import { ledgerStub } from './ledger';
import { type Json, Platform, PlatformError } from './platform';
import { repoStub } from './repo-agents';
import { WORKSPACE_SCOPE, workspaceStub } from './workspace-agents';

export class ApiRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * The workspace a path segment names: decoded once, and accepted only when it is a canonical
 * account identifier (yoneda-core::account: a username, an org name, or an email address
 * for accounts made before email-only sign-up), so `@`, `+` and the rest of an email's local
 * part arrive intact and nothing else gets through. Null otherwise.
 */
export function workspaceName(segment: string | undefined): string | null {
  if (!segment) return null;
  let name: string;
  try {
    name = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return isCanonicalAccountIdentifier(name) ? name : null;
}

/** The caller's standing in `workspace`: whether they own it, and its repositories they own. A
 * personal workspace belongs to its account from sign-up, before it has any repository. */
async function access(caller: Platform, workspace: string) {
  const [listed, orgs, session] = await Promise.all([
    caller.repos(),
    caller.orgs().catch(() => ({ orgs: [] as Json[] })),
    caller.session().catch(() => null),
  ]);
  const repos = ((listed.repos ?? []) as Json[])
    .filter((r) => r.owner === workspace && r.role === 'owner')
    .map((r) => ({ id: String(r.id), name: String(r.name) }));
  const orgOwner = ((orgs.orgs ?? []) as Json[]).some(
    (o) => o.org === workspace && o.role === 'owner',
  );
  const personal = session?.authenticated === true && session.username === workspace;
  if (!personal && !orgOwner && repos.length === 0)
    throw new ApiRefusal('FORBIDDEN', 'Only a workspace owner can manage its agents', 403);
  return repos;
}

async function credit(env: ManagedEnv, workspace: string): Promise<ManagedCredit> {
  const b = await ledgerStub(env, workspace).balance();
  // A workspace that never ran an agent shows the starting credit its first run adds.
  const fresh = b.granted === 0 && b.used === 0;
  const granted = fresh ? STARTING_CREDIT_USD * 1_000_000 : b.granted;
  const left = fresh ? granted : b.balance;
  return {
    granted_usd: granted / 1e6,
    used_usd: b.used / 1e6,
    balance_usd: left / 1e6,
    paused: left <= 0,
  };
}

async function runsOf(env: ManagedEnv, repos: string[], agent: string | null, limit: number) {
  const lists = await Promise.all(repos.map((r) => repoStub(env, r).runs(agent, limit)));
  return lists.flat().sort((a, b) => b.created_at - a.created_at);
}

async function agentState(
  env: ManagedEnv,
  workspace: string,
  agent: ManagedAgentDefinition,
): Promise<AgentState> {
  const stored = await workspaceStub(env, workspace).settings(agent.id);
  const runs = await runsOf(env, stored.enabled, agent.id, 200);
  return {
    ...agent,
    settings: resolveSettings(agent, stored.workspace),
    customized: customizedFields(stored.workspace),
    repo_overrides: Object.fromEntries(
      Object.entries(stored.repos).map(([r, o]) => [r, customizedFields(o)]),
    ),
    enabled_repos: stored.enabled,
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

/** Mints the agents' repository token and registers their webhook, as the owner. */
async function connect(env: ManagedEnv, req: Request, repo: string, workspace: string) {
  const stub = repoStub(env, repo);
  if (await stub.connection()) return;
  const owner = new Platform(env, { forward: req });
  let name = TOKEN_NAME;
  let minted: Json;
  try {
    minted = await owner.createToken(repo, name, TOKEN_SCOPES);
  } catch (e) {
    // Token names are never reused: a revoked earlier token keeps the plain name.
    if (!(e instanceof PlatformError && e.code === 'ALREADY_EXISTS')) throw e;
    name = `${TOKEN_NAME}-${Date.now().toString(36)}`;
    minted = await owner.createToken(repo, name, TOKEN_SCOPES);
  }
  const hook = await owner.createHook(
    repo,
    `${env.PUBLIC_URL.replace(/\/$/, '')}/hooks/${repo}`,
    HOOK_EVENTS,
  );
  await stub.link(repo, {
    account: workspace,
    token_name: name,
    token: String(minted.token),
    hook_id: Number(hook.id),
    hook_secret: String(hook.secret),
  });
}

/** Revokes a repository's agent token and deletes its webhook once no agent runs there. A token
 * or hook already gone is fine; the connection is forgotten either way. */
async function disconnect(env: ManagedEnv, req: Request, repo: string) {
  const stub = repoStub(env, repo);
  const connection = await stub.connection().catch(() => null);
  if (!connection) return;
  const owner = new Platform(env, { forward: req });
  const gone = (e: unknown) => {
    if (!(e instanceof PlatformError && (e.status === 404 || e.code === 'NOT_FOUND'))) throw e;
  };
  await owner.revokeToken(repo, connection.token_name).catch(gone);
  await owner.deleteHook(repo, connection.hook_id).catch(gone);
  await stub.unlink();
}

async function update(
  env: ManagedEnv,
  req: Request,
  workspace: string,
  agent: ManagedAgentDefinition,
  owned: { id: string }[],
) {
  const body = (await req.json().catch(() => null)) as Json | null;
  if (!body || typeof body !== 'object')
    throw new ApiRefusal('INVALID_INPUT', 'Send a JSON object', 400);
  const ws = workspaceStub(env, workspace);
  const stored = await ws.settings(agent.id);
  const by = 'workspace owner';
  if (body.settings !== undefined) {
    const scope = body.scope ? String(body.scope) : WORKSPACE_SCOPE;
    if (scope && !owned.some((r) => r.id === scope))
      throw new ApiRefusal('FORBIDDEN', 'That repository is not one you own here', 403);
    const current = scope ? (stored.repos[scope] ?? {}) : stored.workspace;
    try {
      const base = scope ? resolveSettings(agent, stored.workspace) : agent.defaults;
      const overrides = validateOverrides({ ...agent, defaults: base }, current, body.settings);
      await ws.save(agent.id, scope, overrides, by);
    } catch (e) {
      if (e instanceof SettingsError) throw new ApiRefusal('INVALID_INPUT', e.message, 400);
      throw e;
    }
  }
  if (body.repos !== undefined) {
    if (
      !Array.isArray(body.repos) ||
      !body.repos.every((r: unknown) => typeof r === 'string' && REPO_ID.test(r))
    )
      throw new ApiRefusal('INVALID_INPUT', 'repos lists repository ids', 400);
    const wanted = [...new Set(body.repos as string[])];
    if (!wanted.every((r) => owned.some((o) => o.id === r)))
      throw new ApiRefusal(
        'FORBIDDEN',
        'Agents run only on repositories you own in this workspace',
        403,
      );
    for (const repo of wanted) {
      await connect(env, req, repo, workspace);
      await repoStub(env, repo).setEnabled(agent.id, true, by);
    }
    for (const repo of stored.enabled.filter((r) => !wanted.includes(r))) {
      const stub = repoStub(env, repo);
      await stub.setEnabled(agent.id, false, by);
      if ((await stub.enabled()).length === 0) await disconnect(env, req, repo);
    }
    await ws.setEnabled(agent.id, wanted);
    if (wanted.length) await ledgerStub(env, workspace).ensureStartingCredit();
  }
  return agentState(env, workspace, agent);
}

export async function managedApi(req: Request, env: ManagedEnv, parts: string[]): Promise<Json> {
  const [scope, segment, resource, id, sub] = parts;
  const workspace = workspaceName(segment);
  if (scope !== 'workspaces' || !workspace)
    throw new ApiRefusal('NOT_FOUND', 'Unknown managed API path', 404);
  const owned = await access(new Platform(env, { forward: req }), workspace);
  const url = new URL(req.url);
  const get = req.method === 'GET';
  if (!resource && get)
    return {
      workspace,
      agents: await Promise.all(MANAGED_AGENTS.map((a) => agentState(env, workspace, a))),
      credit: await credit(env, workspace),
      billing: 'coming',
      repos: owned,
      token_name: TOKEN_NAME,
    };
  if (resource === 'agents' && id) {
    const agent = MANAGED_AGENTS.find((a) => a.id === id);
    if (!agent) throw new ApiRefusal('NOT_FOUND', 'Unknown agent', 404);
    if (get) return agentState(env, workspace, agent);
    if (req.method === 'PUT') return update(env, req, workspace, agent, owned);
  }
  const repos = owned.map((r) => r.id);
  if (resource === 'runs' && !id && get) {
    const agent = url.searchParams.get('agent') as ManagedAgentId | null;
    const repo = url.searchParams.get('repo');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const runs = await runsOf(env, repo ? repos.filter((r) => r === repo) : repos, agent, limit);
    return { runs: runs.slice(0, limit) };
  }
  if (resource === 'runs' && id && sub && get) {
    if (!repos.includes(id)) throw new ApiRefusal('NOT_FOUND', 'Unknown run', 404);
    const stub = repoStub(env, id);
    const run = await stub.run(sub);
    if (!run) throw new ApiRefusal('NOT_FOUND', 'Unknown run', 404);
    const listed = env.TRANSCRIPTS
      ? await env.TRANSCRIPTS.list({ prefix: `transcripts/${id}/${sub}/` })
      : null;
    const newest = listed?.objects.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())[0];
    const transcript = newest ? await (await env.TRANSCRIPTS?.get(newest.key))?.text() : null;
    return {
      run,
      findings: await stub.findings(sub),
      transcript: transcript ?? null,
      cost: await ledgerStub(env, workspace).runEntries(sub),
    };
  }
  if (resource === 'billing' && !id && get) {
    const runs = await runsOf(env, repos, null, 200);
    const usage = new Map<
      string,
      { repo: string; agent: string; runs: number; cost_usd: number }
    >();
    for (const r of runs) {
      const key = `${r.repo}:${r.agent}`;
      const row = usage.get(key) ?? { repo: r.repo, agent: r.agent, runs: 0, cost_usd: 0 };
      row.runs++;
      row.cost_usd += r.cost_usd;
      usage.set(key, row);
    }
    return {
      workspace,
      credit: await credit(env, workspace),
      payment_method: null,
      billing: 'coming',
      usage: [...usage.values()].map((u) => ({
        ...u,
        repo_name: owned.find((o) => o.id === u.repo)?.name ?? u.repo,
      })),
    };
  }
  throw new ApiRefusal('NOT_FOUND', 'Unknown managed API path', 404);
}
