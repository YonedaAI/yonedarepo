// Managed agents Worker configuration: bindings, the gateway's provider slugs and the run and
// queue shapes. Which harness and model each agent uses is the agent's settings
// (shared/managed-agents.ts defaults, overridden per workspace or repository), validated
// against the billing rate table; a fallback model is only ever one the agent lists.
import type { ManagedAgentId, ModelProvider } from '../../shared/managed-agents';
import type { HarnessContainer } from './harness';
import type { CreditLedger } from './ledger';
import type { RepoAgents } from './repo-agents';
import type { WorkspaceAgents } from './workspace-agents';

export interface ManagedEnv {
  /** The deployed commit, set by `cargo xtask deploy`; /health reports it. */
  BUILD_REVISION?: string;
  REPOS: DurableObjectNamespace<RepoAgents>;
  WORKSPACES: DurableObjectNamespace<WorkspaceAgents>;
  LEDGER: DurableObjectNamespace<CreditLedger>;
  HARNESS: DurableObjectNamespace<HarnessContainer>;
  REVIEWS: Workflow<RunParams>;
  RUNS: Queue<QueueMessage>;
  /** Run transcripts (redacted, capped); optional, a run without it keeps none. */
  TRANSCRIPTS?: R2Bucket;
  /** The platform Worker: its public API (`/api/v1`) and Git only. */
  PLATFORM: Fetcher;
  /** This Worker's public origin; webhooks are registered at `${PUBLIC_URL}/hooks/<repo>`. */
  PUBLIC_URL: string;
  /** `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>` (one gateway per env). */
  AI_GATEWAY_URL: string;
  /** Provider → the gateway's provider slug: `claude=anthropic,codex=openai,zai=custom-zai,…`. */
  AI_GATEWAY_PROVIDERS: string;
  /** Worker secret, optional: the gateway's token when it is authenticated. */
  AI_GATEWAY_TOKEN?: string;
  /** Worker secret: 64 hex characters sealing stored repository tokens and hook secrets. */
  MANAGED_VAULT_KEY?: string;
  /** Worker secret, optional: bearer for granting credit; unset means nobody may. */
  MANAGED_ADMIN_TOKEN?: string;
  CLAUDE_KEY?: SecretsStoreSecret;
  CODEX_KEY?: SecretsStoreSecret;
  ZAI_KEY?: SecretsStoreSecret;
  MIMO_KEY?: SecretsStoreSecret;
}

/** A Workflow instance's input: one agent reviewing one change head. */
export interface RunParams {
  repo: string;
  account: string;
  agent: ManagedAgentId;
  run: string;
  attempt: number;
  change: number;
  head: string;
}

export type QueueMessage =
  | {
      kind: 'event';
      repo: string;
      event: string;
      ref: string | null;
      commit: string | null;
      change: number | null;
      action: string | null;
    }
  | { kind: 'resume'; repo: string; run: string };

export class ConfigError extends Error {}

/** The gateway slug for a provider, from AI_GATEWAY_PROVIDERS. */
export function gatewaySlug(env: ManagedEnv, provider: ModelProvider): string {
  const pairs = String(env.AI_GATEWAY_PROVIDERS ?? '')
    .split(',')
    .map((pair) => pair.trim().split('='));
  const slug = pairs.find(([name]) => name === provider)?.[1];
  if (!slug || !/^[a-z0-9-]+$/.test(slug))
    throw new ConfigError(`AI_GATEWAY_PROVIDERS has no slug for ${provider}`);
  return slug;
}

export function gatewaySlugs(env: ManagedEnv): Record<ModelProvider, string> {
  const out = {} as Record<ModelProvider, string>;
  for (const p of ['claude', 'codex', 'zai', 'mimo'] as const) out[p] = gatewaySlug(env, p);
  return out;
}

export const REPO_ID = /^r[0-9a-f]{20}$/;
export const COMMIT_ID = /^[0-9a-f]{40}$/;
/** The repository token the agents use; a landing policy names it as check poster. */
export const TOKEN_NAME = 'yoneda-managed-agents';
export const TOKEN_SCOPES = ['read', 'review', 'check'];
export const HOOK_EVENTS = ['change', 'branch'];
