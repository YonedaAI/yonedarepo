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
  conflicts: {
    conflict_id: string;
    candidate_id: string;
    status: string;
    expected_commit: string;
    actual_commit?: string;
    message?: string;
    declared_paths?: string[];
  }[];
  overlaps: { path: string; candidates: string[]; status: string }[];
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
    capture_kind?: 'task_handoff' | 'team_integration' | 'repair' | 'candidate';
    execution_id: string;
    execution_epoch: number;
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
