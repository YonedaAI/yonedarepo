import type {
  CandidateDiffPageContract,
  ConflictStatusContract,
  FileProvenanceContract,
  RepositoryOverviewContract,
  RunGraphPageContract,
  RunsPageContract,
} from '../../../shared/provenance';

export type AccountIdentity =
  | { role: 'user'; username: string; reviewer?: boolean }
  | { role: 'admin' };
export type SetupStage =
  | 'queued'
  | 'checking_remote'
  | 'creating'
  | 'importing'
  | 'checking_source'
  | 'initializing'
  | 'failed'
  | 'ready';

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  author: string;
  recorded_at: number;
  data: Record<string, any>;
}
export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  evidence: string;
}
export interface Repository {
  id: string;
  name: string;
  created_at?: number;
  version: number;
  head_commit: string;
  published_commit: string;
  status: string;
  pending: string | null;
  error?: string;
  error_code?: string;
  stage?: SetupStage;
  setup_started_at?: number;
  updated_at?: number;
  site?: { digest: string; commit: string };
  remote: { namespace: string; name: string };
  policy?: {
    suite: string;
    version: string;
    environment: string;
    required_checks: string[];
    build?: { setup: unknown[]; checks: unknown[]; static_dir?: string };
  };
}
export type ProjectMetadata = Pick<
  Repository,
  'id' | 'name' | 'status' | 'error' | 'error_code' | 'stage' | 'setup_started_at' | 'updated_at'
>;
export interface Snapshot {
  repository: Repository;
  runs: Record<string, any>[];
  executions: Record<string, any>[];
  candidates: Record<string, any>[];
  evaluations: Record<string, any>[];
  decisions: Record<string, any>[];
  artifacts: Record<string, any>[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  seq: number;
  watermark?: number;
  graph_paged?: boolean;
  team_tasks?: Record<string, any>[];
  team_handoffs?: Record<string, any>[];
  capabilities?: {
    agent_limits?: AgentLimits;
    model_budgets?: number;
    optional_model_requests?: number;
    published_continuation?: number;
    collaborative_runs?: number;
    team_planning?: number;
  };
}
export interface AgentLimits {
  min_root_agents: number;
  max_root_agents: number;
  max_run_executions: number;
  max_delegation_depth: number;
  max_run_model_requests: number | null;
}
export interface Graph {
  coverage?: string;
  truncated?: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export type RepositoryOverview = Omit<RepositoryOverviewContract, 'repository'> & {
  repository: Repository;
};
export type RunsPage = RunsPageContract;
export type RunGraphPage = RunGraphPageContract;
export type CandidateDiffPage = CandidateDiffPageContract;
/** A run detail stays Snapshot-compatible and contains only data scoped to that run. */
export interface RunDetail extends Omit<Snapshot, 'runs'> {
  runs: [Record<string, any>];
  watermark?: number;
}
export type ConflictStatus = ConflictStatusContract;
export type FileProvenanceView = FileProvenanceContract;
