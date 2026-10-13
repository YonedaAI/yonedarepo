import type { ComparisonState } from '../../lib/comparison';

export function ComparisonAssessment({ comparison }: { comparison?: ComparisonState }) {
  const review = comparison?.latest_review;
  if (!review)
    return comparison?.selected_by === 'owner' && comparison.selection_reason ? (
      <section className="comparison-assessment" aria-label="Recorded owner choice">
        <h3>Why this result was chosen</h3>
        <p>{comparison.selection_reason}</p>
        <small>Owner choice · no automatic review is recorded.</small>
      </section>
    ) : (
      <p className="subtle">No automatic review is recorded for this run.</p>
    );
  return (
    <section className="comparison-assessment" aria-label="Recorded reviewer assessment">
      <h3>
        {review.outcome === 'selected'
          ? comparison?.selected_by === 'owner' &&
            review.selected_candidate_id !== comparison.selected_candidate_id
            ? 'Reviewer’s original proposal'
            : 'Why this approach was proposed'
          : review.outcome === 'repair_requested'
            ? 'Why a repair was requested'
            : 'Why review needs attention'}
      </h3>
      <small>Reviewer assessment · agent assertion. Behavior checks are shown separately.</small>
      {review.outcome !== 'selected' && <p>{review.rationale}</p>}
      <h4>Tradeoffs between alternatives</h4>
      <ul>
        {review.alternatives.map((alternative, index) => (
          <li key={alternative.candidate_id ?? alternative.execution_id ?? index}>
            <strong>Alternative {index + 1}</strong>
            <p>{alternative.reason}</p>
          </li>
        ))}
      </ul>
      <h4>Risks</h4>
      {review.risks.length ? (
        <ul>
          {review.risks.map((risk, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Immutable reviewer risks may repeat and have no item state.
            <li key={`${index}:${risk}`}>{risk}</li>
          ))}
        </ul>
      ) : (
        <p>No risks were recorded by the reviewer.</p>
      )}
      {review.outcome === 'selected' && (
        <details>
          <summary>Read full reviewer assessment</summary>
          <p>{review.rationale}</p>
        </details>
      )}
      {comparison?.selected_by === 'owner' && (
        <p>
          <strong>Owner choice:</strong> {comparison.selection_reason} The reviewer’s proposal above
          is unchanged.
        </p>
      )}
    </section>
  );
}
