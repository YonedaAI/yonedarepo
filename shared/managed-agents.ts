// Managed agents (cloudflare/managed): the reviewers YonedaRepo maintains and runs for a
// workspace as an ordinary API client of the platform, their maintained defaults, the model
// table (harness, provider, model and an explicit fallback order), the billing rate table and
// the wire shapes the browser reads from `/api/managed/*`. A workspace's settings override
// these defaults field by field; a field it never changed follows the defaults as they update.
import { MANAGED_INSTRUCTIONS } from './managed-instructions';

export type ManagedAgentId = 'code-review' | 'security-review' | 'slop-review';
/** The stock CLI a run drives inside its container. */
export type Harness = 'claude-code' | 'codex' | 'opencode';
export type ModelProvider = 'claude' | 'codex' | 'zai' | 'mimo';
export type Reasoning = 'low' | 'medium' | 'high';
/** `pass_fail`: the check passes or fails. `level`: low, medium or high (lower is better). */
export type ValueType = 'pass_fail' | 'level';
export type RunValue = 'pass' | 'fail' | 'low' | 'medium' | 'high';

export interface ModelChoice {
  harness: Harness;
  provider: ModelProvider;
  model: string;
}

export interface Trigger {
  /** `push`: every push to a change's branch; `ready`: when the change is marked ready. */
  when: 'push' | 'ready';
  /** Which changes: `ready_for_review` (every open change, where approvals are not gated). */
  changes: 'ready_for_review';
  /** Path prefixes a change must touch; empty means any. */
  paths: string[];
  /** Branch names (or `prefix/*`) a change's branch must match; empty means any. */
  branches: string[];
}

/** The fields a workspace (or a repository) can change; anything unset follows the default. */
export interface AgentSettings {
  name: string;
  description: string;
  harness: Harness;
  provider: ModelProvider;
  model: string;
  reasoning: Reasoning;
  timeout_minutes: number;
  instructions: string;
  trigger: Trigger;
  /** For level agents: the value at or above which the check fails (null: never blocks). */
  block_at: RunValue | null;
}

export interface ManagedAgentDefinition {
  id: ManagedAgentId;
  /** One line for the overview card. */
  pitch: string;
  icon: 'code' | 'shield' | 'siren';
  /** The check recorded on the change's head (a landing policy may require it). */
  check: string;
  value_type: ValueType;
  polarity: 'lower_is_better';
  defaults: AgentSettings;
  /** Tried in order when the default model cannot run; each one is logged on the run. */
  fallback: ModelChoice[];
  /** Model spend a single run may reach before it is stopped, in USD. */
  cost_cap_usd: number;
}

const TRIGGER: Trigger = { when: 'push', changes: 'ready_for_review', paths: [], branches: [] };

export const MANAGED_AGENTS: readonly ManagedAgentDefinition[] = [
  {
    id: 'code-review',
    pitch: 'Reads every change like a careful colleague and flags the bugs worth fixing first.',
    icon: 'code',
    check: 'code-review',
    value_type: 'pass_fail',
    polarity: 'lower_is_better',
    defaults: {
      name: 'Code review',
      description: 'Finds correctness bugs, broken edge cases and risky changes, line by line.',
      // Live on dev (2026-10-30): GLM-5.3 Flash missed the seeded off-by-one once and failed
      // to run once; GPT-5.6 Luna found all three seeded problems for $0.007.
      harness: 'codex',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      reasoning: 'medium',
      timeout_minutes: 20,
      instructions: MANAGED_INSTRUCTIONS['code-review'],
      trigger: TRIGGER,
      block_at: null,
    },
    // No fallback: the cheaper GLM-5.3 Flash failed this agent's acceptance, and a reviewer that
    // misses bugs would pass the check; a failed run is the honest outcome.
    fallback: [],
    cost_cap_usd: 1,
  },
  {
    id: 'security-review',
    pitch: 'Checks each change for the holes attackers look for, before it lands.',
    icon: 'shield',
    check: 'security-review',
    value_type: 'pass_fail',
    polarity: 'lower_is_better',
    defaults: {
      name: 'Security review',
      description:
        'Looks for injection, missing access checks, leaked secrets and unsafe input handling.',
      harness: 'claude-code',
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      reasoning: 'medium',
      timeout_minutes: 20,
      instructions: MANAGED_INSTRUCTIONS['security-review'],
      trigger: TRIGGER,
      block_at: null,
    },
    fallback: [],
    cost_cap_usd: 3,
  },
  {
    id: 'slop-review',
    pitch:
      'Catches dead code, debug leftovers and drift from your conventions while they are small.',
    icon: 'siren',
    check: 'slop-review',
    value_type: 'level',
    polarity: 'lower_is_better',
    defaults: {
      name: 'Slop review',
      description:
        'Spots sloppy patterns before they spread: leftovers, duplication, vague comments, filler.',
      harness: 'opencode',
      provider: 'mimo',
      model: 'mimo-v2.6-flash',
      reasoning: 'low',
      timeout_minutes: 15,
      instructions: MANAGED_INSTRUCTIONS['slop-review'],
      trigger: TRIGGER,
      block_at: null,
    },
    fallback: [{ harness: 'opencode', provider: 'zai', model: 'glm-5.3-flash' }],
    cost_cap_usd: 0.5,
  },
];

export const managedAgent = (id: string) => MANAGED_AGENTS.find((a) => a.id === id);

/** Which providers each harness can drive: Claude Code speaks Anthropic Messages (Claude, and
 * the Anthropic-compatible GLM and MiMo endpoints), Codex the OpenAI Responses API, and
 * opencode is the harness for GLM and MiMo. */
export const HARNESS_PROVIDERS: Record<Harness, readonly ModelProvider[]> = {
  'claude-code': ['claude', 'zai', 'mimo'],
  codex: ['codex'],
  opencode: ['zai', 'mimo'],
};
export const HARNESS_LABELS: Record<Harness, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'opencode',
};

/** Price = provider list rate × AGENT_MARGIN (the pricing page's MARGIN). */
export const AGENT_MARGIN = 1.3;
/** Promotional credit added on a workspace's first run; no card is asked for. */
export const STARTING_CREDIT_USD = 5;
/** Container time per run (standard-1), billed at the pricing page's check-minute rate. */
export const CONTAINER_USD_PER_MINUTE = 0.0017;

/** Provider list prices in USD per million tokens, by usage category. */
export interface ModelRate {
  provider: ModelProvider;
  model: string;
  label: string;
  input: number;
  /** Cache writes (the longest cache duration's rate, so a write is never under-billed). */
  cache_write: number;
  cache_read: number;
  output: number;
  /** A higher tier for long prompts: prices above `above_input_tokens` input tokens. */
  long?: {
    above_input_tokens: number;
    input: number;
    cache_write: number;
    cache_read: number;
    output: number;
  };
  source_url: string;
  verified_at: string;
}

/** The billing rate table, read from each provider's own pricing page on 2026-10-29. */
export const MODEL_RATES: readonly ModelRate[] = [
  {
    provider: 'zai',
    model: 'glm-5.3-flash',
    label: 'GLM-5.3 Flash',
    input: 0.15,
    cache_write: 0, // listed as limited-time free
    cache_read: 0.03,
    output: 0.5,
    source_url: 'https://docs.z.ai/guides/overview/pricing',
    verified_at: '2026-10-29',
  },
  {
    provider: 'zai',
    model: 'glm-5.3',
    label: 'GLM-5.3',
    input: 1.4,
    cache_write: 0,
    cache_read: 0.26,
    output: 4.4,
    source_url: 'https://docs.z.ai/guides/overview/pricing',
    verified_at: '2026-10-29',
  },
  {
    provider: 'mimo',
    model: 'mimo-v2.6-flash',
    label: 'MiMo V2.6 Flash',
    input: 0.14,
    cache_write: 0,
    cache_read: 0.14, // no cache-hit rate listed: billed as input
    output: 0.28,
    source_url: 'https://mimo.mi.com/docs/en-US/price/pay-as-you-go',
    verified_at: '2026-10-29',
  },
  {
    provider: 'mimo',
    model: 'mimo-v2.6-pro',
    label: 'MiMo V2.6 Pro',
    input: 0.435,
    cache_write: 0,
    cache_read: 0.435,
    output: 0.87,
    source_url: 'https://mimo.mi.com/docs/en-US/price/pay-as-you-go',
    verified_at: '2026-10-29',
  },
  {
    provider: 'codex',
    model: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    input: 0.2,
    cache_write: 0,
    cache_read: 0.02,
    output: 1.2,
    source_url: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
    verified_at: '2026-10-29',
  },
  {
    provider: 'claude',
    model: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    input: 0.1,
    cache_write: 0.2,
    cache_read: 0.01,
    output: 0.5,
    long: {
      above_input_tokens: 100_000,
      input: 0.5,
      cache_write: 1,
      cache_read: 0.05,
      output: 2.5,
    },
    source_url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    verified_at: '2026-10-29',
  },
  {
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    input: 2,
    cache_write: 4,
    cache_read: 0.1,
    output: 10,
    source_url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    verified_at: '2026-10-29',
  },
];

export const modelRate = (provider: string, model: string) =>
  MODEL_RATES.find((r) => r.provider === provider && r.model === model) ?? null;

/** The models a harness may run, from its providers' rated models. */
export const harnessModels = (harness: Harness) =>
  MODEL_RATES.filter((r) => HARNESS_PROVIDERS[harness].includes(r.provider));

/** Token usage of one model request, by category. */
export interface TokenUsage {
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
}

/** List cost of `usage` in micro-USD (rounded up), with the long-prompt tier when it applies. */
export function usageCostMicrousd(rate: ModelRate, usage: TokenUsage): number {
  const prompt = usage.input + usage.cache_write + usage.cache_read;
  const r = rate.long && prompt > rate.long.above_input_tokens ? rate.long : rate;
  return Math.ceil(
    usage.input * r.input +
      usage.cache_write * r.cache_write +
      usage.cache_read * r.cache_read +
      usage.output * r.output,
  );
}

/** What a workspace pays for `costMicrousd` of list cost: × AGENT_MARGIN, rounded up. */
export const chargeMicrousd = (costMicrousd: number) => Math.ceil(costMicrousd * AGENT_MARGIN);

export type RunStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'findings'
  | 'paused'
  | 'superseded'
  | 'cancelled'
  | 'failed';

/** One agent run on one change head (`GET /api/managed/.../runs`). */
export interface ManagedRun {
  id: string;
  agent: ManagedAgentId;
  repo: string;
  change: number;
  head: string;
  status: RunStatus;
  /** The result: pass/fail, or low/medium/high; null until the run reports. */
  value: RunValue | null;
  /** The agent's summary as posted (defused; null when none or withheld as a credential). */
  summary: string | null;
  harness: Harness;
  provider: string;
  model: string;
  /** Set when the run used a fallback model, with why. */
  fallback: string | null;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  /** What the workspace was charged (models plus container time, × margin), USD. */
  cost_usd: number;
  container_seconds: number;
  findings: number;
  /** Findings dropped before posting (no line of the diff to anchor to, or a credential). */
  withheld: number;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

/** Automatic top-up: with a card on file, a balance below `below_usd` adds `add_usd`, charged
 * to the card (the pricing page's top-up). */
export const AUTO_TOP_UP = { below_usd: 5, add_usd: 20 } as const;

/** The saved card, as Stripe describes it: brand and last four digits only. */
export interface CardOnFile {
  brand: string;
  last4: string;
  added_at: number;
}

export interface ManagedCredit {
  granted_usd: number;
  used_usd: number;
  balance_usd: number;
  /** True when the balance is spent: runs wait (status paused) until credit exists. */
  paused: boolean;
  /** The promotional credit a card on file unlocks (configured per deployment), once. */
  promo: { usd: number; granted: boolean };
  card: CardOnFile | null;
  /** Why the last automatic top-up failed (null when it did not): runs stop at $0. */
  top_up_failed: string | null;
  /** Whether a saved card is charged when the balance runs low (on unless switched off). */
  auto_top_up: boolean;
}

/** One automatic top-up charged to the card. */
export interface TopUp {
  id: string;
  amount_usd: number;
  status: 'pending' | 'succeeded' | 'failed';
  error: string | null;
  created_at: number;
}

/** Whether card billing is available here (`stripe`), or not set up yet (`coming`). */
export type BillingMode = 'stripe' | 'coming';

/** A posted finding, kept for the run's detail page. */
export interface RunFinding {
  path: string;
  line: number;
  severity: string;
  title: string;
  why: string;
}

/** One tile of an agent's history strip (newest first). */
export type RunTile = Pick<
  ManagedRun,
  'id' | 'repo' | 'change' | 'value' | 'status' | 'created_at'
>;

/** `GET|PUT /api/managed/workspaces/:ws/agents/:agent`. */
export interface AgentState extends ManagedAgentDefinition {
  /** The effective workspace settings (defaults plus the workspace's overrides). */
  settings: AgentSettings;
  /** Fields the workspace changed; the rest follow YonedaRepo's maintained defaults. */
  customized: string[];
  /** Repositories with their own overrides, and which fields. */
  repo_overrides: Record<string, string[]>;
  enabled_repos: string[];
  history: RunTile[];
  runs: number;
  /** Set up in this workspace (Add agent was done): who and when; null until then. */
  created_by: string | null;
  created_at: number | null;
  /** False while paused: set up and kept, but starts no run. */
  active: boolean;
  /** Runs on every repository the caller owns in the workspace, new ones included. */
  all_repos: boolean;
}

/** The body of `PUT /api/managed/workspaces/:ws/agents/:agent`: settings to change (a field set to
 * null follows the default again), optionally for one repository (`scope`), and/or the full list
 * of repositories the agent runs on (enabling mints each one's token and webhook). */
export interface AgentUpdate {
  settings?: { [K in keyof AgentSettings]?: AgentSettings[K] | null };
  scope?: string;
  repos?: string[];
  /** Pause (false) or resume (true): repositories and settings are kept either way. */
  active?: boolean;
  /** Run on all repositories, including ones created later (true), instead of `repos`. */
  all_repos?: boolean;
}

/** `POST /api/managed/workspaces/:ws/sync`: repositories newly connected for agents set to run on
 * all repositories (the web app asks after creating or importing one). */
export interface SyncResult {
  connected: number;
}

/** `POST /api/managed/workspaces/:ws/agents/:agent/run` (Run now): open changes reviewed at
 * their heads now; a head already reviewed is not reviewed again. */
export interface RunNowResult {
  started: number;
  already: number;
}

/** One row of a repository's Agents page (`GET /api/managed/workspaces/:ws/repos/:repo/agents`). */
export interface RepoAgentRow {
  id: ManagedAgentId;
  name: string;
  status: 'active' | 'paused' | 'off';
  harness: Harness;
  model: string;
  latest: RunTile | null;
}

/** Whether a change counts as ready for review: open, and not marked a draft in its title
 * (`Draft:`, `WIP:` or `[WIP]`, the common conventions; the platform has no draft state). */
export function readyForReview(change: { status?: unknown; title?: unknown }): boolean {
  if (change.status !== undefined && change.status !== 'open') return false;
  return !/^\s*(draft:|wip:|\[wip\]|\[draft\])/i.test(String(change.title ?? ''));
}

/** `GET /api/managed/workspaces/:ws`: the Agents overview. */
export interface WorkspaceState {
  workspace: string;
  agents: AgentState[];
  credit: ManagedCredit;
  billing: BillingMode;
  /** Repositories the caller owns in this workspace (the Repositories checklist). */
  repos: { id: string; name: string }[];
  token_name: string;
}

/** One charge in a run's cost breakdown (amount in micro-USD, negative = charged). */
export interface CostEntry {
  kind: 'charge';
  amount: number;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microusd: number | null;
  note: string | null;
  at: number;
}

/** `GET /api/managed/workspaces/:ws/runs/:repo/:run`. */
export interface RunDetail {
  run: ManagedRun;
  findings: RunFinding[];
  /** The harness CLI's transcript tail, redacted; null when none was kept. */
  transcript: string | null;
  cost: CostEntry[];
}

/** `GET /api/managed/workspaces/:ws/billing`. */
export interface BillingState {
  workspace: string;
  credit: ManagedCredit;
  /** The saved card (brand and last 4), or null. */
  payment_method: CardOnFile | null;
  billing: BillingMode;
  /** The top-up rule, and whether it is on (switched off, the card stays saved). */
  auto_top_up: { below_usd: number; add_usd: number; enabled: boolean };
  top_ups: TopUp[];
  usage: {
    repo: string;
    repo_name: string;
    agent: ManagedAgentId;
    runs: number;
    cost_usd: number;
  }[];
}
