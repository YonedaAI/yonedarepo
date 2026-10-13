export interface ComparisonReview {
  id: string;
  outcome: 'selected' | 'repair_requested' | 'needs_attention';
  selected_candidate_id: string | null;
  rationale: string;
  alternatives: { candidate_id: string | null; execution_id?: string; reason: string }[];
  risks: string[];
  manifest_digest: string;
  evidence_refs: string[];
}
export interface ComparisonState {
  version: 1;
  status:
    | 'building'
    | 'checking'
    | 'reviewing'
    | 'repairing'
    | 'selected'
    | 'needs_attention'
    | 'stale';
  round: number;
  selected_candidate_id: string | null;
  latest_review_id: string | null;
  latest_review: ComparisonReview | null;
  selected_by?: 'owner' | 'comparison_reviewer';
  selection_reason?: string;
  selection_version?: number;
  selection_request_id?: string;
  manifest_digest?: string;
  approval?: { id: string; digest: string; request_id?: string } | null;
}
export type ComparisonOwnerOperation = 'approve_comparison_review' | 'select_comparison_candidate';
export type ComparisonAction = (
  operation: ComparisonOwnerOperation,
  body: Record<string, unknown>,
) => Promise<boolean>;
