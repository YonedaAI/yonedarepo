import type { ExecutionContainer } from './container';
import type { YonedaEntrypoint } from './entrypoint';
export type Json = Record<string, any>;
export type Envelope = { v: 1; repo_id: string; job_id: string; kind: string };
export interface Env {
  REPOSITORIES: DurableObjectNamespace;
  WORKSPACES: DurableObjectNamespace;
  LIVE: DurableObjectNamespace;
  EXECUTIONS: DurableObjectNamespace<ExecutionContainer>;
  SELF: Service<YonedaEntrypoint>;
  OBJECTS: R2Bucket;
  INDEX: D1Database;
  ARTIFACTS: Artifacts;
  ASSETS: Fetcher;
  AGENT_QUEUE: Queue<Envelope>;
  CAPTURE_QUEUE: Queue<Envelope>;
  EVALUATE_QUEUE: Queue<Envelope>;
  PUBLISH_QUEUE: Queue<Envelope>;
  OPENAI_KEY: { get(): Promise<string> };
  ANTHROPIC_KEY: { get(): Promise<string> };
  MIMO_KEY?: { get(): Promise<string> };
  ZAI_KEY?: { get(): Promise<string> };
  VAULT_KEY?: string;
  AUTH_LIMITER?: RateLimit;
  OWNER_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ARTIFACTS_NAMESPACE: string;
  CODEX_MODEL: string;
  CLAUDE_MODEL: string;
  MIMO_MODEL?: string;
  ZAI_MODEL?: string;
  STARTER_REPO?: string;
  SITE_ORIGIN?: string;
}
export type Principal = {
  workspace: string;
  role: 'user' | 'admin' | 'agent';
  grant?: { id: string; repo: string; scope: string };
};
export type Scope = {
  repo_id: string;
  job: Json;
  supervisor: string;
  fork?: string;
  model_calls: number;
  created_at: number;
};
