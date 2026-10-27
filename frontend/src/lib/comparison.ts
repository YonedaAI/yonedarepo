/**
 * The owner's selection among a compare run's results (`select_comparison_candidate`), separate
 * from publication. Runs recorded before the comparison reviewer was retired may still carry
 * its review fields; the browser reads only the selection.
 */
export interface ComparisonState {
  version: 1;
  status: string;
  selected_candidate_id: string | null;
  selected_by?: string;
  selection_reason?: string;
  selection_version?: number;
  selection_request_id?: string;
  [retired: string]: unknown;
}
export type ComparisonAction = (
  operation: 'select_comparison_candidate',
  body: Record<string, unknown>,
) => Promise<boolean>;
