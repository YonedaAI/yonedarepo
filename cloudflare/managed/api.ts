// The browser's `/api/managed/*`, reached through the front Worker on the site's own origin.
// Every request is authorized by the platform with the caller's own credential: reading needs
// read access to the repository, and enabling or disabling an agent needs its owner (who alone
// may mint the scoped token and register the webhook the agents use). The billed account is
// the repository's owner.
import {
  MANAGED_AGENTS,
  type ManagedAgentId,
  type ManagedRepoState,
  STARTING_CREDIT_USD,
} from '../../shared/managed-agents';
import {
  agentConfig,
  HOOK_EVENTS,
  type ManagedEnv,
  REPO_ID,
  TOKEN_NAME,
  TOKEN_SCOPES,
} from './config';
import { ledgerStub } from './ledger';
import { type Json, Platform, PlatformError } from './platform';
import { repoStub } from './repo-agents';

export class ApiRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function state(env: ManagedEnv, repo: string, status: Json): Promise<ManagedRepoState> {
  const account = String(status.owner);
  const stub = repoStub(env, repo);
  const [summary, connection, balance] = await Promise.all([
    stub.summary(),
    stub.connection(),
    ledgerStub(env, account).balance(),
  ]);
  // An account that never used an agent shows the starting credit it gets on first enable.
  const fresh = balance.granted === 0 && balance.used === 0;
  const granted = fresh ? STARTING_CREDIT_USD * 1_000_000 : balance.granted;
  const left = fresh ? granted : balance.balance;
  return {
    repo,
    account,
    agents: MANAGED_AGENTS.map((definition) => {
      const row = summary.find((s) => s.agent === definition.id);
      let model = { provider: definition.provider, model: definition.model };
      try {
        const deployed = agentConfig(env, definition.id);
        model = { provider: deployed.provider, model: deployed.model };
      } catch {
        // A misconfigured agent shows its default; enabling it is refused below.
      }
      return {
        ...definition,
        ...model,
        enabled: row?.enabled ?? false,
        last_run: row?.last_run ?? null,
      };
    }),
    credit: {
      granted_usd: granted / 1_000_000,
      used_usd: balance.used / 1_000_000,
      balance_usd: left / 1_000_000,
      paused: left <= 0,
    },
    billing: 'coming',
    token_name: connection?.token_name ?? TOKEN_NAME,
  };
}

/** Mints the agents' repository token and registers their webhook, as the owner. */
async function connect(env: ManagedEnv, req: Request, repo: string, account: string) {
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
  await repoStub(env, repo).link({
    account,
    token_name: name,
    token: String(minted.token),
    hook_id: Number(hook.id),
    hook_secret: String(hook.secret),
  });
}

export async function managedApi(req: Request, env: ManagedEnv, parts: string[]): Promise<Json> {
  const [repos, repo, resource, agentId] = parts;
  if (repos !== 'repos' || !REPO_ID.test(repo ?? ''))
    throw new ApiRefusal('NOT_FOUND', 'Unknown managed API path', 404);
  const caller = new Platform(env, { forward: req });
  const status = await caller.status(repo);
  const url = new URL(req.url);
  if (!resource && req.method === 'GET') return state(env, repo, status);
  if (resource === 'runs' && !agentId && req.method === 'GET') {
    const agent = url.searchParams.get('agent');
    const limit = Number(url.searchParams.get('limit') ?? 50);
    return { runs: await repoStub(env, repo).runs(agent, limit) };
  }
  if (resource === 'agents' && agentId && req.method === 'POST') {
    if (!MANAGED_AGENTS.some((a) => a.id === agentId))
      throw new ApiRefusal('NOT_FOUND', 'Unknown agent', 404);
    if (status.viewer?.owner !== true)
      throw new ApiRefusal('FORBIDDEN', 'Only the repository owner can turn agents on or off', 403);
    const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== 'boolean')
      throw new ApiRefusal('INVALID_INPUT', 'Send {"enabled": true} or {"enabled": false}', 400);
    const id = agentId as ManagedAgentId;
    const stub = repoStub(env, repo);
    const account = String(status.owner);
    if (body.enabled) {
      try {
        agentConfig(env, id);
      } catch (e: any) {
        throw new ApiRefusal('NOT_CONFIGURED', String(e?.message ?? e), 503);
      }
      if (!(await stub.connection())) await connect(env, req, repo, account);
      await ledgerStub(env, account).ensureStartingCredit();
    }
    await stub.setEnabled(id, body.enabled, String(status.viewer?.principal ?? 'owner'));
    return state(env, repo, status);
  }
  throw new ApiRefusal('NOT_FOUND', 'Unknown managed API path', 404);
}
