import { useState } from 'react';
import type { ComparisonState } from '../../lib/comparison';
import { ComparisonAssessment } from './ComparisonAssessment';

export function reviewedPublishingInput(
  comparison: ComparisonState,
  candidate: string,
  note: string,
) {
  const review = comparison.latest_review;
  const override = comparison.selected_by === 'owner' ? comparison.selection_reason : undefined;
  const rationale = [
    review ? `Reviewer assessment: ${review.rationale}` : '',
    override ? `Owner choice: ${override}` : '',
    note.trim() ? `Owner note: ${note.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    rationale,
    alternatives: (review?.alternatives ?? [])
      .filter((a) => a.candidate_id && a.candidate_id !== candidate)
      .map((a) => ({
        candidate: a.candidate_id as string,
        reason: override ? `Owner choice: ${override}. Reviewer assessment: ${a.reason}` : a.reason,
      })),
  };
}
export function ReviewedDecisionForm({
  comparison,
  candidate,
  busy,
  blocked,
  onAccept,
  onClose,
  confirmationKey = candidate,
}: {
  comparison: ComparisonState;
  candidate: string;
  busy: boolean;
  blocked?: boolean;
  onAccept: (
    rationale: string,
    alternatives: { candidate: string; reason: string }[],
  ) => Promise<void>;
  onClose: () => void;
  confirmationKey?: string;
}) {
  const [note, setNote] = useState('');
  const [confirmedKey, setConfirmedKey] = useState('');
  const confirmed = confirmedKey === confirmationKey;
  const input = reviewedPublishingInput(comparison, candidate, note);
  return (
    <form
      className="decision-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !blocked && confirmed && input.rationale)
          void onAccept(input.rationale, input.alternatives);
      }}
    >
      <ComparisonAssessment comparison={comparison} />
      <label>
        Optional publishing note
        <textarea
          value={note}
          disabled={busy}
          maxLength={2048}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <label className="publish-confirmation">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy || blocked}
          onChange={(event) => setConfirmedKey(event.target.checked ? confirmationKey : '')}
        />
        I confirm publication of this exact checked result.
      </label>
      <p>
        Publishes the selected source after Git verification. The recorded reviewer proposal is
        retained.
      </p>
      <div>
        <button type="submit" disabled={busy || blocked || !confirmed || !input.rationale}>
          Publish result
        </button>
        <button type="button" className="quiet" disabled={busy} onClick={onClose}>
          Continue reviewing
        </button>
      </div>
    </form>
  );
}
