/** Presentation DTOs supplied by a verified owner-read adapter; never source/write authority. */
export interface SourcePreparation {
  version: 1;
  status: 'pending' | 'preparing' | 'ready' | 'failed';
  reason?: 'source_changed' | 'unavailable' | 'access_denied';
}
export type SourceWorkflowStage = 'waiting' | 'working' | 'checking' | 'review' | 'cancelled';
/** Native run-detail headers; run_id is added only by the verified multi-run UI merge. */
export interface SourcePreparationJob {
  job_id: string;
  kind: 'agent' | 'evaluate';
  status: 'pending' | 'ready' | 'failed';
  stage: 'source_preparing';
  epoch: number;
  observed_at: number;
  not_before: number | null;
  runtime_started_at: number | null;
  run_id?: string;
}
export interface SourcePathListRef {
  version: 1;
  id: string;
  digest: string;
  count: number;
}
export interface SourceRevision {
  repository: string;
  commit: string;
  tree?: string;
}
interface SourceScope {
  repo_id: string;
  run_id?: string;
}
export type SourceSelection = SourceScope &
  (
    | {
        kind: 'proposed';
        workspace_id: string;
        epoch: number;
        workspace_version: number;
        base: SourceRevision;
      }
    | { kind: 'captured'; candidate_id: string; revision: SourceRevision }
    | {
        kind: 'checked';
        candidate_id: string;
        evaluation_id: string;
        policy_version: string;
        revision: SourceRevision;
      }
    | { kind: 'published'; decision_id?: string; revision: SourceRevision }
  );
export interface SourceFileEntry {
  path: string;
  blob_id: string;
  size_bytes: number;
  encoding: 'text' | 'binary' | 'unknown';
  file_version?: number;
  change?: 'add' | 'modify' | 'rename' | 'delete';
  previous_path?: string;
}
export interface SourceFilePage {
  source: SourceSelection;
  items: SourceFileEntry[];
  next_cursor: string | null;
  has_more: boolean;
}
export interface SourceFileSlice {
  source: SourceSelection;
  path: string;
  blob_id: string;
  offset: number;
  file_version?: number;
  bytes: Uint8Array;
  total_bytes: number;
  has_more: boolean;
}
export interface SourceContextLink {
  id: string;
  label: string;
  record_version?: string | number;
  source_revision?: SourceRevision;
}
export interface SourceFileTrail {
  source: SourceSelection;
  path: string;
  coverage: 'recorded' | 'unknown';
  explanation?: string;
  reasons?: { id: string; authority: 'agent_assertion' | 'owner_decision'; text: string }[];
  capture_receipts?: {
    id: string;
    commit: string;
    path: string;
    change: string;
    capture_epoch?: number;
  }[];
  evaluation?: {
    id: string;
    policy_version: string;
    suite: string;
    environment: string;
    evidence_digest: string;
  };
  checks: { name: string; status: 'pass' | 'fail' | 'pending' }[];
  risks: string[];
  revisions: { label: string; selection: SourceSelection }[];
  context: SourceContextLink[];
}
export interface SourceReader {
  list: (source: SourceSelection, cursor: string | null, limit: number) => Promise<SourceFilePage>;
  read: (
    source: SourceSelection,
    file: SourceFileEntry,
    offset: number,
    limit: number,
  ) => Promise<SourceFileSlice>;
  provenance: (source: SourceSelection, path: string) => Promise<SourceFileTrail>;
}
