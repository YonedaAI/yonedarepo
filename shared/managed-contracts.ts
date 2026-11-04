// Wire contracts for managed review runs, workspace settings and billing.
import type {
  AgentSettings,
  Harness,
  ManagedAgentDefinition,
  ManagedAgentId,
  RunValue,
} from './managed-agent-types';

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
  /** Additive API features; absent on a deployment predating exact-head requests. */
  capabilities?: 'exact_head_review'[];
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
  /** Failed attempts retained before an explicit retry; costs are cumulative at that point. */
  previous_attempts?: { attempt: number; run: ManagedRun; findings: RunFinding[] }[];
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
