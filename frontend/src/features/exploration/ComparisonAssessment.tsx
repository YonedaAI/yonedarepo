import type { ComparisonState } from '../../lib/comparison';

/** The owner's recorded reason for choosing this result; nothing is shown without one. */
export function ComparisonAssessment({ comparison }: { comparison?: ComparisonState }) {
  if (comparison?.selected_by !== 'owner' || !comparison.selection_reason) return null;
  return (
    <section className="comparison-assessment" aria-label="Recorded owner choice">
      <h3>Why this result was chosen</h3>
      <p>{comparison.selection_reason}</p>
      <small>Owner choice</small>
    </section>
  );
}
