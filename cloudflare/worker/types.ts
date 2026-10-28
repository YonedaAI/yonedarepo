export type Json = Record<string, any>;
export type Envelope = { v: 1; repo_id: string; job_id: string; kind: string; workspace?: string };
export interface Env {
  WORKSPACES: DurableObjectNamespace;
  /** Source platform authority: one SourceRepository per repository. */
  SOURCE_REPOS: DurableObjectNamespace;
  /** Commit shards (platform write path); absent where not yet deployed. */
  COMMIT_SHARDS?: DurableObjectNamespace;
  /** Land combiners, one per branch (platform write path); absent where not deployed. */
  LAND_COMBINERS?: DurableObjectNamespace;
  /** Landing mode: batch (default) or changeset (see repo-changesets.ts). */
  LAND_MODE?: string;
  /** "true" lets a request choose its landing mode (x-yoneda-land-mode), for benchmarks. */
  LAND_MODE_OVERRIDE?: string;
  /** Platform check executors (one fresh container per run attempt). */
  CHECK_RUNNERS: DurableObjectNamespace<import('./check-container').CheckContainer>;
  OBJECT_PUSHES: DurableObjectNamespace<import('./repo-push-queue').ObjectPushQueue>;
  /** Platform jobs (projection, derived data, webhooks, purges). */
  PLATFORM_QUEUE: Queue<Envelope>;
  /** Check runs on their own queue (minutes each), so they never hold derive and
   * projection jobs' consumer slots; absent where not deployed (PLATFORM_QUEUE then). */
  PLATFORM_CHECKS?: Queue<Envelope>;
  /** This account's workers.dev subdomain: its Workers are never webhook targets (without
   * it, no workers.dev host is). */
  WORKERS_SUBDOMAIN?: string;
  /** Basin Pipelines stream for change-log analytics (platform-dev only; optional). */
  CHANGELOG?: { send(records: import('./repo-changelog').ChangeEvent[]): Promise<void> };
  /** Durable imports of external Git repositories into the source platform. */
  PLATFORM_IMPORT: Workflow<import('./repo-import').ImportParams>;
  OBJECTS: R2Bucket;
  INDEX: D1Database;
  ARTIFACTS: Artifacts;
  ASSETS: Fetcher;
  /** The platform's own review-model key (model checks); never an agent-layer key. */
  REVIEW_MODEL_KEY?: { get(): Promise<string> };
  AUTH_LIMITER?: RateLimit;
  OWNER_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ARTIFACTS_NAMESPACE: string;
  /** `r2` stores new source-platform repositories' Git objects in R2 (local development). */
  PLATFORM_OBJECT_STORE?: string;
  /** The website people sign in at (device approval page `/device`); the platform falls
   * back to the request origin. */
  WEB_ORIGIN?: string;
  /** The source platform Worker (front Worker); its public API is all it calls. */
  PLATFORM?: Fetcher;
  PUBLIC_APP_ORIGIN?: string;
  BUILD_REVISION?: string;
}
export type Principal = {
  workspace: string;
  role: 'user' | 'admin';
};
