export interface ContextTarget {
  id: string;
  digest?: string | null;
  kind: string;
  label: string;
  authority: string;
  relation?: string | null;
}

export interface ContextRevision {
  repository: string;
  commit: string;
}

export interface ContextCheck {
  name: string;
  status: string;
  detail: string;
}

export interface ContextEvaluation {
  candidate_id: string;
  execution_id: string;
  evaluation_id: string;
  revision: ContextRevision;
  evidence: string;
  policy: string;
  checks: ContextCheck[];
  authority: 'checked_revision';
}

export interface ContextCitation {
  record_id: string;
  seq: number | null;
  at: number;
  epoch: number | null;
  execution_id: string | null;
  authority: 'assertion';
  targets: ContextTarget[];
  candidates: {
    id: string;
    capture_job_id: string;
    revision: ContextRevision;
    evaluation: ContextEvaluation | null;
    capture_kind?: 'task_contribution' | 'integration' | null;
    source_handoff?: string | null;
  }[];
}

export interface ContextAccess {
  seq: number;
  call_id: string;
  at: number;
  tool: string;
  stage: 'returned' | 'opened';
  execution_id: string | null;
  job_id: string | null;
  epoch: number | null;
  session_id: string | null;
  targets: ContextTarget[];
}

export interface ContextUsage {
  version: 1;
  run_id: string | null;
  coverage: {
    status: 'recorded' | 'partial' | 'unavailable';
    reason: string;
    activated_at: number;
  };
  counts: {
    assigned: number;
    returned: number;
    opened: number;
    cited: number;
    checked: number;
    read_calls: number;
  };
  assigned: { execution_id: string; stage: 'assigned'; targets: ContextTarget[] }[];
  entries: ContextAccess[];
  citations: ContextCitation[];
  checked: ContextEvaluation[];
  citations_truncated: boolean;
  next_cursor: number;
  has_more: boolean;
}
