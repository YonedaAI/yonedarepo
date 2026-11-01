// The admin Operations, Agents and Infrastructure tabs' wire shapes. Operations and Agents come
// from our own points (Analytics Engine); Infrastructure from Cloudflare's GraphQL Analytics API,
// which runs a few minutes behind, so each answer says what time it covers.
import type { TrafficBucket, TrafficRange } from './site-traffic';

/** Which optional admin tabs this platform has. */
export interface AdminReports {
  operations: boolean;
  visitors: boolean;
  agents: boolean;
}

/** The clients an agent can name: what a token's name or a user agent has to hold, and how it
 * reads. Self-reported, so a point keeps one of these and never the words it came from. */
export const AGENT_CLIENTS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'opencode',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  gemini: 'Gemini CLI',
  aider: 'Aider',
  cline: 'Cline',
  goose: 'Goose',
  windsurf: 'Windsurf',
  devin: 'Devin',
};

/** One self-reported client's use. `client` is an AGENT_CLIENTS key, or empty: none named. */
export interface AgentClientRow {
  client: string;
  credentials: number;
  requests: number;
  landings: number;
  estimated: boolean;
}

/** What agent credentials did over a range. Credentials are the measure: one can run many
 * processes. */
export interface AgentReport {
  range: TrafficRange;
  credentials: number;
  /** Approximate: one for each half hour on the clock a credential was seen in. */
  sessions: number;
  repositories: number;
  /** Organizations that own the repositories reached. */
  organizations: number;
  /** The most credentials seen in one minute. */
  concurrency: number;
  reads: number;
  writes: number;
  /** MCP calls can be reads or writes, so they count apart. */
  mcp_calls: number;
  landings: number;
  landings_refused: number;
  landings_failed: number;
  /** Requests that didn't succeed; `unauthorized` and `rate_limited` are among them. */
  failures: number;
  unauthorized: number;
  rate_limited: number;
  /** Landed over landings asked for; null with none asked for. */
  success_rate: number | null;
  /** Rounds repeated and landings asked for again, over landings asked for. Can pass 1. */
  retry_rate: number | null;
  estimated: boolean;
  bucket: TrafficBucket;
  series: { start: string; end: string; credentials: number; estimated: boolean }[];
  clients: AgentClientRow[];
}

export type AgentResult =
  | { ok: true; report: AgentReport }
  | { ok: false; reason: 'off' | 'not_configured' | 'query_failed' };

/** Outcomes and time to answer for one operation from one kind of client. */
export interface OperationRow {
  operation: string;
  client: string;
  count: number;
  success: number;
  failed: number;
  unauthorized: number;
  rate_limited: number;
  /** Milliseconds. A clone's run to its headers, or to its last byte with REPO_ANALYTICS on. */
  p50: number;
  p95: number;
  p99: number;
  estimated: boolean;
}

export type OperationsResult =
  | { ok: true; range: TrafficRange; rows: OperationRow[] }
  | { ok: false; reason: 'off' | 'not_configured' | 'query_failed' };

export interface QueueRow {
  label: string;
  /** Messages waiting at the end of the window. */
  backlog: number;
  /** Milliseconds a message waited, at worst. */
  wait_ms: number;
  retries: number;
  dead_lettered: number;
  dead_letter_queue: boolean;
}

export interface WorkerRow {
  script: string;
  requests: number;
  errors: number;
  subrequests: number;
  /** CPU milliseconds a request. */
  cpu_p50: number;
  cpu_p99: number;
}

/** A section's figures, or that this one couldn't be read. */
export type Section<T> = { ok: true; value: T } | { ok: false };

export interface Infrastructure {
  /** What the queue and Worker figures cover. */
  start: string;
  end: string;
  queues: Section<QueueRow[]>;
  workers: Section<WorkerRow[]>;
  database: Section<{ latency_p50: number; latency_p90: number; bytes: number }>;
  storage: Section<{ bytes: number; change_7d: number; objects: number }>;
}

/** One step of the way from a visit to a landing. */
export interface FunnelStep {
  step: 'visitors' | 'docs' | 'signups' | 'repositories' | 'pushed' | 'landed';
  count: number;
  estimated: boolean;
}

export interface VisitorCount {
  key: string;
  count: number;
  estimated: boolean;
}

export interface VisitorReport {
  range: TrafficRange;
  /** Unique browsers a day, added up: a hash lasts a day, so a return the next day counts again. */
  visitors: number;
  /** Approximate: one for each half hour on the clock a browser was seen in. */
  sessions: number;
  views: number;
  estimated: boolean;
  bucket: TrafficBucket;
  series: { start: string; end: string; visitors: number; estimated: boolean }[];
  entries: VisitorCount[];
  exits: VisitorCount[];
  referrers: VisitorCount[];
  countries: VisitorCount[];
  devices: VisitorCount[];
  browsers: VisitorCount[];
  funnel: FunnelStep[];
  /** Of accounts at least a week old, those seen again a week or more after they signed up. */
  retention: { cohort: number; returned: number };
  /** New accounts by where they came from, and those that made a repository. */
  campaigns: { key: string; signups: number; repositories: number }[];
}

export type VisitorResult =
  | { ok: true; report: VisitorReport }
  | { ok: false; reason: 'off' | 'not_configured' | 'query_failed' };

export type InfrastructureResult =
  | { ok: true; report: Infrastructure }
  | { ok: false; reason: 'off' | 'not_configured' };
