/** Versioned low-cardinality operation measurements. No identities or resource paths. */
export const OPERATION_POINT = 'operation.v1';
export type MetricKind = 'request' | 'repository' | 'background' | 'browser' | 'transfer';
export type OperationSource =
  | 'web'
  | 'rest'
  | 'mcp'
  | 'git_https'
  | 'git_ssh'
  | 'queue'
  | 'cron'
  | 'workflow'
  | 'alarm'
  | 'monitor'
  | 'unknown';
export type OperationTraffic =
  | 'ordinary'
  | 'marked_automation'
  | 'crawler_claimed'
  | 'agent_claimed'
  | 'automation_claimed'
  | 'health'
  | 'scanner'
  | 'telemetry'
  | 'unknown';
export type OperationActor = 'anonymous' | 'session' | 'token' | 'system' | 'unknown';
export type OperationOutcome = 'ok' | 'refused' | 'failed' | 'cancelled' | 'retry' | 'unknown';

export interface OperationMeasurement {
  component?: string;
  kind: MetricKind;
  operation: string;
  source: OperationSource;
  traffic: OperationTraffic;
  actor: OperationActor;
  outcome: OperationOutcome;
  elapsedMs: number;
  status?: number;
  bytes?: number;
  queueWaitMs?: number;
  attempt?: number;
  firstByteMs?: number;
  region?: string;
  authorityRegion?: string;
  revision?: string;
}

export function operationPoint(m: OperationMeasurement) {
  return {
    indexes: [`${m.kind}:${m.operation}`.slice(0, 96)],
    blobs: [
      OPERATION_POINT,
      m.kind,
      m.operation,
      m.source,
      m.traffic,
      m.actor,
      m.outcome,
      m.region ?? '',
      m.authorityRegion ?? '',
      (m.revision ?? '').slice(0, 12),
      m.component ?? 'unknown',
    ],
    doubles: [
      m.elapsedMs,
      m.status ?? 0,
      m.bytes ?? -1,
      m.queueWaitMs ?? -1,
      m.attempt ?? 1,
      m.firstByteMs ?? -1,
    ],
  };
}

export interface OperationRow {
  component?: string;
  region?: string;
  authorityRegion?: string;
  revision?: string;
  kind: MetricKind;
  operation: string;
  source: OperationSource;
  traffic: OperationTraffic;
  outcome: OperationOutcome;
  actor: OperationActor;
  requests: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  estimated: boolean;
  queueWaitP95: number | null;
}

export interface OperationReport {
  rows: OperationRow[];
  window: { start: number; end: number };
  coverage: {
    enabled: boolean;
    fullUntil: string | null;
    detailEvery: number;
    sampled: boolean;
    truncated?: boolean;
  };
  status: 'ok' | 'off' | 'unavailable';
}
