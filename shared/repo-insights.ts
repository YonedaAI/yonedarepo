// The repository Insights page's and the admin reports' wire shapes: what repositories' points
// (cloudflare/worker/repo-usage.ts) add up to, read back from Workers Analytics Engine. `estimated`
// means some of a figure stands for points Analytics Engine didn't keep: shown with `≈`.
import type { TrafficBucket, TrafficRange } from './site-traffic';

/** One bar of the activity chart. `start` and `end` are ISO times. */
export interface InsightsBar {
  start: string;
  end: string;
  clones: number;
  pushes: number;
  landings: number;
  failed: number;
  estimated: boolean;
}

export interface InsightsCount {
  key: string;
  count: number;
  estimated: boolean;
}

export interface RepoUsage {
  /** Fresh clones. A fetch that brought something is counted apart. */
  clones: number;
  fetches: number;
  pushes: number;
  landings: number;
  /** Refused by a gate or a conflict, or failed. */
  failed_landings: number;
  estimated: boolean;
  bucket: TrafficBucket;
  /** Oldest first, with no gaps. */
  series: InsightsBar[];
  /** Actions by who made them: `person` is a signed-in browser, `agent` an agent credential (with
   * AGENT_REPORT on), `token` any other token, which may be a script or someone at a terminal, or
   * an agent from before that switch; `anonymous` a signed-out clone. */
  who: InsightsCount[];
  /** Why landings failed, busiest first. Keys are `refusalReason`'s. */
  reasons: InsightsCount[];
}

export interface RepoContributor {
  principal: string;
  commits: number;
}

export interface RepoInsights {
  range: TrafficRange;
  ranges: TrafficRange[];
  /** Null when the figures can't be read here; contributors still stand. */
  usage: RepoUsage | null;
  contributors: RepoContributor[];
  /** More contributors than these. */
  more: boolean;
}

export interface LandingLatency {
  p50: number;
  p95: number;
  p99: number;
}

/** Landings over the range, across every repository. Direct pushes aren't landings. */
export interface LandingReport {
  range: TrafficRange;
  landed: number;
  refused: number;
  failed: number;
  /** landed ÷ (landed + refused + failed); null with none of those. */
  success_rate: number | null;
  /** Milliseconds a landing took, and waited in its queue. Null with no landings. */
  latency: LandingLatency | null;
  queue: { p50: number; p95: number } | null;
  /** Rounds the platform repeated, and landings asked for again once they had landed. */
  retries: number;
  reasons: InsightsCount[];
  checks: { run: number; failed: number };
  direct_pushes: { total: number; refused: number };
  estimated: boolean;
}

export type LandingReportResult =
  | { ok: true; report: LandingReport }
  /** `off`: REPO_ANALYTICS isn't on here. */
  | { ok: false; reason: 'off' | 'not_configured' | 'query_failed' };

export interface RepoUsageRow {
  id: string;
  name: string;
  owner: string;
  handle: string | null;
  visibility: 'public' | 'private';
  /** Clones, pushes and landings. */
  actions: number;
  /** Bytes pushed. */
  pushed_bytes: number;
  estimated: boolean;
}

export interface RepoUsageReport {
  range: TrafficRange;
  most_active: RepoUsageRow[];
  /** By bytes pushed over the range: nothing here keeps a repository's past sizes. */
  fastest_growing: RepoUsageRow[];
}

export type RepoUsageResult =
  | { ok: true; report: RepoUsageReport }
  | { ok: false; reason: 'off' | 'not_configured' | 'query_failed' };
