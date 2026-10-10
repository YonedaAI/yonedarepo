export interface RepositoryOverviewContract {
  repository: Record<string, unknown>;
  v: number;
  capabilities: Record<string, unknown>;
  counts: Record<string, number>;
  watermark: number;
}
export interface RunsPageContract<T = Record<string, unknown>> {
  items: T[];
  next_cursor: string | null;
  watermark: number;
  has_more: boolean;
}
export interface RunGraphPageContract {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  next_cursor: string | null;
  has_more: boolean;
  watermark: number;
}
export interface CandidateDiffPageContract {
  diff: string;
  next_cursor: string | null;
  has_more: boolean;
  /** Stable digest of the captured diff used as the page snapshot token. */
  watermark: string;
}
export interface ConflictStatusContract {
  /** New inventory response; `conflicts` remains accepted during route alias rollout. */
  records?: {
    id?: string;
    kind: string;
    candidate_id: string;
    refreshed_candidate_id?: string;
    resolver_candidate_id?: string;
    head_commit?: string;
    expected_head?: string;
    expected_commit?: string;
    expected_version?: number;
    conflict_paths?: string[];
    paths?: string[];
    evidence?: Record<string, unknown>;
    status?: string;
  }[];
  conflicts?: {
    id?: string;
    kind?: string;
    candidate_id: string;
    refreshed_candidate_id?: string;
    resolver_candidate_id?: string;
    head_commit?: string;
    expected_head?: string;
    expected_commit?: string;
    expected_version?: number;
    conflict_paths?: string[];
    paths?: string[];
    evidence?: Record<string, unknown>;
    status?: string;
  }[];
  overlaps: {
    conflict_id?: string;
    candidate_id: string;
    paths: string[];
    status: string;
  }[];
  seq: number;
}
export interface FileProvenanceContract {
  coverage: 'recorded' | 'unknown';
  status: 'recorded' | 'deleted' | 'unknown';
  path: string;
  commit: string;
  lineage: {
    id: string;
    candidate?: string | null;
    handoff_id?: string | null;
    task_id?: string | null;
    task_revision?: number;
    capture_kind?: 'task_handoff' | 'team_integration' | 'repair' | 'candidate' | 'merge_refresh';
    /** Direct capture identity; merge refresh uses byte-matched source attribution instead. */
    execution_id: string | null;
    execution_epoch: number | null;
    source_candidate?: string | null;
    source_execution_id?: string | null;
    source_execution_epoch?: number | null;
    lineage_relation?: 'exact_blob_inherited_by_merge_refresh';
    capture_epoch: number;
    revision: { commit: string };
    path: string;
    old_path?: string | null;
    change: 'add' | 'modify' | 'rename' | 'delete';
    old_blob?: string | null;
    new_blob?: string | null;
    authority: 'trusted_capture';
    candidate_summary?: string;
  }[];
  decisions: Record<string, unknown>[];
  rejected_alternatives: { decision: string; candidate: string; reason: string }[];
}
