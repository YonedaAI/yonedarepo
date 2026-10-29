// Managed agents Worker configuration. Each agent's model is deployment config (a `*_MODEL`
// var, `provider/model`), validated here against the provider registry: only Anthropic
// Messages providers with verified pricing are allowed, and there is no fallback to another
// model. Caps bound every run's worst-case spend before any call is made.

import {
  MANAGED_AGENTS,
  type ManagedAgentDefinition,
  type ManagedAgentId,
} from '../../shared/managed-agents';
import { providerDefinition } from '../../shared/providers';
import type { CreditLedger } from './ledger';
import type { RepoAgents } from './repo-agents';

export interface ManagedEnv {
  REPOS: DurableObjectNamespace<RepoAgents>;
  LEDGER: DurableObjectNamespace<CreditLedger>;
  REVIEWS: Workflow<RunParams>;
  RUNS: Queue<QueueMessage>;
  /** The platform Worker: its public API (`/api/v1`) only. */
  PLATFORM: Fetcher;
  /** This Worker's public origin; webhooks are registered at `${PUBLIC_URL}/hooks/<repo>`. */
  PUBLIC_URL: string;
  /** `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>` (one gateway per env). */
  AI_GATEWAY_URL: string;
  /** Provider id → the gateway's provider slug, `claude=anthropic,zai=custom-zai,…`. */
  AI_GATEWAY_PROVIDERS: string;
  CODE_REVIEW_MODEL: string;
  SECURITY_REVIEW_MODEL: string;
  /** Worker secret, optional: the gateway's token when it is authenticated. */
  AI_GATEWAY_TOKEN?: string;
  /** Worker secret, optional: bearer for granting credit; unset means nobody may. */
  MANAGED_ADMIN_TOKEN?: string;
  CLAUDE_KEY?: SecretsStoreSecret;
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

export type Provider = 'zai' | 'claude' | 'mimo';

/** Per-run caps; a run's worst case is `maxCalls` calls at these sizes. */
export interface Caps {
  maxCalls: number;
  maxOutputTokens: number;
  /** Prompt bytes per call (a token is never shorter than one UTF-8 byte). */
  maxPromptBytes: number;
  maxFiles: number;
  maxComments: number;
}

export interface AgentConfig extends ManagedAgentDefinition {
  provider: Provider;
  caps: Caps;
  price: { input_microusd_per_million: number; output_microusd_per_million: number };
}

const CAPS: Record<ManagedAgentId, Caps> = {
  'code-review': {
    maxCalls: 6,
    maxOutputTokens: 1500,
    maxPromptBytes: 96_000,
    maxFiles: 40,
    maxComments: 15,
  },
  'security-review': {
    maxCalls: 5,
    maxOutputTokens: 1500,
    maxPromptBytes: 48_000,
    maxFiles: 30,
    maxComments: 10,
  },
};
const PROVIDERS = new Set<Provider>(['zai', 'claude', 'mimo']);
const MODEL_VARS: Record<ManagedAgentId, 'CODE_REVIEW_MODEL' | 'SECURITY_REVIEW_MODEL'> = {
  'code-review': 'CODE_REVIEW_MODEL',
  'security-review': 'SECURITY_REVIEW_MODEL',
};

export class ConfigError extends Error {}

/** The agent's deployed configuration; throws ConfigError naming the bad var. */
export function agentConfig(env: ManagedEnv, id: string): AgentConfig {
  const base = MANAGED_AGENTS.find((a) => a.id === id);
  if (!base) throw new ConfigError(`Unknown agent ${id}`);
  const name = MODEL_VARS[base.id];
  const [provider, model] = String(env[name] ?? '').split('/');
  if (!PROVIDERS.has(provider as Provider) || !model)
    throw new ConfigError(`${name} must be zai/<model>, claude/<model> or mimo/<model>`);
  const definition = providerDefinition(provider);
  const price = definition.models.find((m) => m.id === model)?.conservative_pricing;
  if (definition.protocol !== 'anthropic_messages' || !price)
    throw new ConfigError(`${name}: ${model} has no verified pricing`);
  return { ...base, provider: provider as Provider, model, caps: CAPS[base.id], price };
}

/** The gateway slug for a provider, from AI_GATEWAY_PROVIDERS (`claude=anthropic,zai=custom-zai`). */
export function gatewaySlug(env: ManagedEnv, provider: Provider): string {
  const pairs = String(env.AI_GATEWAY_PROVIDERS ?? '')
    .split(',')
    .map((pair) => pair.trim().split('='));
  const slug = pairs.find(([name]) => name === provider)?.[1];
  if (!slug || !/^[a-z0-9-]+$/.test(slug))
    throw new ConfigError(`AI_GATEWAY_PROVIDERS has no slug for ${provider}`);
  return slug;
}

export const REPO_ID = /^r[0-9a-f]{20}$/;
export const COMMIT_ID = /^[0-9a-f]{40}$/;
/** The repository token the agents post with; a landing policy names it as check poster. */
export const TOKEN_NAME = 'yoneda-managed-agents';
export const TOKEN_SCOPES = ['read', 'review', 'check'];
export const HOOK_EVENTS = ['change', 'branch'];
