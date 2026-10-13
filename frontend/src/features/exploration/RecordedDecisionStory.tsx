import { short } from '../../lib/api';

const publicationStates: Record<string, string> = {
  published: 'Published',
  publication_pending: 'Publication pending',
  publication_failed: 'Publication failed',
  publication_conflict: 'Publication conflict',
};

/** Show stored selection and tradeoffs even when alternative captures are no longer loaded. */
export function RecordedDecisionStory({ decision }: { decision: Record<string, any> }) {
  return (
    <div className="recorded-decision-story">
      <strong>
        {decision.decision_kind === 'development_verification'
          ? 'Automated development selection · fixture verification'
          : 'Owner decision'}
      </strong>
      <p>
        Selected revision <code>{short(decision.target?.commit)}</code>
        {decision.target?.repository && (
          <>
            {' '}
            · <code>{decision.target.repository}</code>
          </>
        )}
        {decision.candidate && (
          <>
            {' '}
            · candidate <code>{decision.candidate}</code>
          </>
        )}
      </p>
      <p>{decision.rationale || 'No rationale was recorded.'}</p>
      <p>
        {publicationStates[decision.status] || 'Publication status unavailable'}
        {decision.status === 'publication_pending' &&
          ' · selection is recorded; publication is unresolved.'}
        {decision.status === 'publication_failed' &&
          ' · selection is recorded; publication did not complete.'}
        {decision.status === 'publication_conflict' &&
          ' · inspect the source conflict before continuing.'}
      </p>
      {decision.error && <p role="alert">{decision.error}</p>}
      <strong>Rejected alternatives and reasons</strong>
      {decision.alternatives?.length ? (
        <ul>
          {decision.alternatives.map((alternative: Record<string, any>) => (
            <li key={alternative.candidate}>
              <code>{alternative.candidate}</code>
              <p>{alternative.reason || 'No rejection reason was recorded.'}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p>No rejected alternatives were recorded.</p>
      )}
    </div>
  );
}
