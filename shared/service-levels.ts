// What the platform measures for its service targets, as the Workers write it and the admin page
// reads it. No target lives here: they follow 30 days of data (docs/observability-plan.md). Every
// point sits in the site's Analytics Engine dataset with its own `blob1`.
export const SERVICE_OPERATIONS = [
  'api_read',
  'landing',
  'git_clone',
  'git_push',
  'repo_create',
] as const;
export type ServiceOperation = (typeof SERVICE_OPERATIONS)[number];
export type ServiceClass = 'ok' | 'refused' | 'failed';

/** Days of data before anyone sets a target. */
export const MEASURING_DAYS = 30;

/** One point per this many requests: only reads are many enough to sample. */
export const SERVICE_EVERY: Record<ServiceOperation, number> = {
  api_read: 10,
  landing: 1,
  git_clone: 1,
  git_push: 1,
  repo_create: 1,
};

/** What a request is, from its method and path alone: the tail hides ids in a URL, so no pattern
 * here reads one. */
export function serviceOperation(method: string, path: string): ServiceOperation | null {
  if (method === 'POST') {
    if (path === '/api/v1/repos') return 'repo_create';
    if (/^\/api\/v1\/repos\/[^/]+\/land$/.test(path)) return 'landing';
    if (path.endsWith('/git-upload-pack')) return 'git_clone';
    if (path.endsWith('/git-receive-pack')) return 'git_push';
    return null;
  }
  if (method !== 'GET' && method !== 'HEAD') return null;
  return path.startsWith('/api/v1/') && !path.startsWith('/api/v1/admin') ? 'api_read' : null;
}

/** 0 is a Worker that died with no answer. A refusal is the client's, and counts for nobody. */
export function serviceClass(status: number): ServiceClass {
  if (status === 0 || status >= 500) return 'failed';
  return status >= 400 ? 'refused' : 'ok';
}

/** Spans a point has room for, after the fields below. */
export const POINT_SPANS = 14;
const INDEX_BYTES = 96;
const REVISION_LENGTH = 12;

export interface RequestPoint {
  /** The route's shape: never a repository, an account or a request id. */
  name: string;
  revision: string;
  own: boolean;
  /** The measured operation, or null for a request only sampled for its spans. */
  operation: ServiceOperation | null;
  status: number;
  totalMs: number;
  /** Requests this point stands for in the service counts: 0 when it isn't one of them. */
  weight: number;
  spans: { name: string; ms: number }[];
}

/** blob1 `spans`, blob2 route, blob3 release, blob4 `own`, blob5 operation, blob6 class, then span
 * names; double1 total, double2 status, double3 weight, then span times. */
export function requestPoint(p: RequestPoint) {
  const spans = p.spans.slice(0, POINT_SPANS);
  return {
    indexes: [p.name.slice(0, INDEX_BYTES)],
    blobs: [
      'spans',
      p.name,
      p.revision.slice(0, REVISION_LENGTH),
      p.own ? 'own' : '',
      p.operation ?? '',
      serviceClass(p.status),
      ...spans.map((s) => s.name),
    ],
    doubles: [p.totalMs, p.status, p.weight, ...spans.map((s) => s.ms)],
  };
}

/** One synthetic result: blob1 `probe`, blob2 check, blob3 release, blob4 class; double1 ms. */
export const probePoint = (check: string, ok: boolean, ms: number, revision: string | null) => ({
  indexes: [`probe ${check}`],
  blobs: ['probe', check, (revision ?? '').slice(0, REVISION_LENGTH), ok ? 'ok' : 'failed'],
  doubles: [ms],
});

export interface ServiceRow {
  operation: ServiceOperation;
  /** Good, refused and failed. */
  requests: number;
  failed: number;
  /** Failed over good plus failed; null with neither. */
  failure_rate: number | null;
  /** Of good requests, in milliseconds; null with none. */
  latency: { p50: number; p95: number; p99: number } | null;
  estimated: boolean;
}
export interface ProbeRow {
  check: string;
  runs: number;
  failed: number;
  /** Of good runs, in milliseconds; null with none. */
  latency: { p50: number; p95: number } | null;
}
export interface ServiceLevels {
  /** Days with data, up to MEASURING_DAYS. */
  days_measured: number;
  people: ServiceRow[];
  ours: ServiceRow[];
  outside: ProbeRow[];
}
export type ServiceLevelsResult =
  | { ok: true; report: ServiceLevels }
  | { ok: false; reason: 'off' | 'not_configured' | 'query_failed' };
