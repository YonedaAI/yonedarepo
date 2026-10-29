// Managed agents (cloudflare/managed): the predefined reviewers YonedaRepo runs for a
// repository as an ordinary API client of the platform, and the wire shapes the browser reads
// from `/api/managed/*`. Model rates come from the provider registry (yoneda-core
// `provider_registry.json`); the price is that rate × AGENT_MARGIN, the same margin as the
// pricing page's meters. Which model an agent uses is deployment config (the managed Worker's
// `*_MODEL` vars); the defaults below are what infra/envs/*.json set.
import { providerDefinition } from './providers';

export type ManagedAgentId = 'code-review' | 'security-review';

export interface ManagedAgentDefinition {
  id: ManagedAgentId;
  label: string;
  /** What it does, in a sentence the Agents page prints. */
  description: string;
  /** The check it records on the change's head commit (a landing policy may require it). */
  check: string;
  /** The default model: the lowest-cost one that met this agent's acceptance criteria. */
  provider: 'zai' | 'claude' | 'mimo';
  model: string;
}

export const MANAGED_AGENTS: readonly ManagedAgentDefinition[] = [
  {
    id: 'code-review',
    label: 'Code review',
    description:
      'Reads each change when it opens or is pushed, comments on the lines with problems and records a code-review check.',
    check: 'code-review',
    provider: 'zai',
    model: 'glm-5.3-flash',
  },
  {
    id: 'security-review',
    label: 'Security review',
    description:
      'Looks for security problems (injection, secrets, unsafe input handling, access checks) and records a security-review check.',
    check: 'security-review',
    provider: 'claude',
    model: 'claude-sonnet-5-5',
  },
];

export const managedAgent = (id: string) => MANAGED_AGENTS.find((a) => a.id === id);

/** Price = provider list rate × AGENT_MARGIN (pricing.ts MARGIN). */
export const AGENT_MARGIN = 1.3;
/** Promotional credit on an account's first managed-agent use; no card is asked for. */
export const STARTING_CREDIT_USD = 5;

export interface AgentRate {
  provider: string;
  model: string;
  /** Provider list rates, USD per million tokens. */
  input_cost_per_million: number;
  output_cost_per_million: number;
  /** What an account pays: cost × AGENT_MARGIN, USD per million tokens. */
  input_price_per_million: number;
  output_price_per_million: number;
  basis: string;
  source_url: string;
  verified_at: string;
}

/** The rate row for a model, or null when the registry has no verified pricing for it. */
export function agentRate(provider: string, model: string): AgentRate | null {
  const entry = providerDefinition(provider).models.find((m) => m.id === model);
  const price = entry?.conservative_pricing;
  if (!entry || !price) return null;
  const input = price.input_microusd_per_million / 1_000_000;
  const output = price.output_microusd_per_million / 1_000_000;
  return {
    provider,
    model,
    input_cost_per_million: input,
    output_cost_per_million: output,
    input_price_per_million: Number((input * AGENT_MARGIN).toFixed(6)),
    output_price_per_million: Number((output * AGENT_MARGIN).toFixed(6)),
    basis: entry.pricing_basis ?? price.source,
    source_url: entry.pricing_source_url ?? '',
    verified_at: entry.pricing_verified_at ?? '',
  };
}

/** The default models' rates, one row per distinct model, for the pricing page. */
export function defaultAgentRates(): AgentRate[] {
  const seen = new Set<string>();
  const rows: AgentRate[] = [];
  for (const agent of MANAGED_AGENTS) {
    const key = `${agent.provider}/${agent.model}`;
    const rate = agentRate(agent.provider, agent.model);
    if (rate && !seen.has(key)) rows.push(rate);
    seen.add(key);
  }
  return rows;
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'findings'
  | 'paused'
  | 'superseded'
  | 'cancelled'
  | 'failed';

/** One agent run on one change head (`GET /api/managed/repos/:repo/runs`). */
export interface ManagedRun {
  id: string;
  agent: ManagedAgentId;
  change: number;
  head: string;
  status: RunStatus;
  provider: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  /** What the account was charged (cost × margin), USD. */
  cost_usd: number;
  findings: number;
  /** Findings dropped before posting (a credential in the text, or no valid anchor). */
  withheld: number;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface ManagedAgentState extends ManagedAgentDefinition {
  enabled: boolean;
  last_run: ManagedRun | null;
}

export interface ManagedCredit {
  granted_usd: number;
  used_usd: number;
  balance_usd: number;
  /** True when the balance is spent: runs wait (status paused) until credit exists. */
  paused: boolean;
}

/** `GET /api/managed/repos/:repo` and the answer to enabling or disabling an agent. */
export interface ManagedRepoState {
  repo: string;
  /** The account billed: the repository's owner. */
  account: string;
  agents: ManagedAgentState[];
  credit: ManagedCredit;
  /** Real payment is not built: the page offers "Set up billing (coming)". */
  billing: 'coming';
  /** The repository token the agents post with (a landing policy's check poster). */
  token_name: string;
}
