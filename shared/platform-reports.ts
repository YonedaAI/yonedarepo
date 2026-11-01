// The admin Operations and Infrastructure tabs' wire shapes. Operations comes from our own points
// (Analytics Engine); Infrastructure from Cloudflare's GraphQL Analytics API, which runs a few
// minutes behind, so each answer says what time it covers.
import type { TrafficBucket, TrafficRange } from './site-traffic';

/** Which optional admin tabs this platform has. */
export interface AdminReports {
  operations: boolean;
  visitors: boolean;
}

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
