import type { AgentsEntrypoint } from './agents-entrypoint';
import type { ExecutionContainer } from './container';
export type Json = Record<string, any>;
export type Envelope = { v: 1; repo_id: string; job_id: string; kind: string; workspace?: string };
export interface Env {
  REPOSITORIES: DurableObjectNamespace;
  WORKSPACES: DurableObjectNamespace;
  /** Source staging is separate from workspace accounts and spending authority. */
  SOURCES?: DurableObjectNamespace;
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
  /** Platform jobs (check runs); independent of agent queues. */
  PLATFORM_QUEUE: Queue<Envelope>;
  /** Check runs on their own queue (minutes each), so they never hold derive and
   * projection jobs' consumer slots; absent where not deployed (PLATFORM_QUEUE then). */
  PLATFORM_CHECKS?: Queue<Envelope>;
  /** Basin Pipelines stream for change-log analytics (platform-dev only; optional). */
  CHANGELOG?: { send(records: import('./repo-changelog').ChangeEvent[]): Promise<void> };
  /** Durable imports of external Git repositories into the source platform. */
  PLATFORM_IMPORT: Workflow<import('./repo-import').ImportParams>;
  LIVE: DurableObjectNamespace;
  EXECUTIONS: DurableObjectNamespace<ExecutionContainer>;
  SELF: Service<AgentsEntrypoint>;
  OBJECTS: R2Bucket;
  INDEX: D1Database;
  ARTIFACTS: Artifacts;
  ASSETS: Fetcher;
  AGENT_QUEUE: Queue<Envelope>;
  CAPTURE_QUEUE: Queue<Envelope>;
  EVALUATE_QUEUE: Queue<Envelope>;
  OPENAI_KEY: { get(): Promise<string> };
  ANTHROPIC_KEY: { get(): Promise<string> };
  MIMO_KEY?: { get(): Promise<string> };
  ZAI_KEY?: { get(): Promise<string> };
  GEMINI_KEY?: { get(): Promise<string> };
  VAULT_KEY?: string;
  AUTH_LIMITER?: RateLimit;
  OWNER_TOKEN?: string;
  /** `secrets-store` enables owner-bound managed Z.ai/MiMo connections (staging only). */
  MANAGED_PROVIDER_KEYS?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ARTIFACTS_NAMESPACE: string;
  /** `r2` stores new source-platform repositories' Git objects in R2 (local development). */
  PLATFORM_OBJECT_STORE?: string;
  CODEX_MODEL: string;
  CLAUDE_MODEL: string;
  MIMO_MODEL?: string;
  ZAI_MODEL?: string;
  STARTER_REPO?: string;
  SITE_ORIGIN?: string;
  APP_ORIGIN?: string;
  APPS?: Fetcher;
  /** The source platform Worker (agents-only deployment); its public API is all we call. */
  PLATFORM?: Fetcher;
  PUBLIC_APP_ORIGIN?: string;
  BUILD_REVISION?: string;
  /** Only disposable *-acceptance namespaces can activate this controlled exercise. */
}
export type Principal = {
  workspace: string;
  role: 'user' | 'admin' | 'agent';
  reviewer?: boolean;
  grant?: { id: string; repo: string; scope: string; expires?: number };
};
export type Scope = {
  repo_id: string;
  job: Json;
  supervisor: string;
  fork?: string;
  model_calls: number;
  created_at: number;
};
