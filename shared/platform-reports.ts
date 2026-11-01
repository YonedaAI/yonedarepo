// The admin Operations and Infrastructure tabs' wire shapes. Operations comes from our own points
// (Analytics Engine); Infrastructure from Cloudflare's GraphQL Analytics API, which runs a few
// minutes behind, so each answer says what time it covers.
import type { TrafficRange } from './site-traffic';

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

export type InfrastructureResult =
  | { ok: true; report: Infrastructure }
  | { ok: false; reason: 'off' | 'not_configured' };
