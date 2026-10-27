import { useState } from 'react';
import type { ComparisonState } from '../../lib/comparison';
import { ComparisonAssessment } from './ComparisonAssessment';

/** The decision rationale is the owner's recorded choice plus any publishing note. */
export function selectionRationale(comparison: ComparisonState, note: string) {
  const choice = comparison.selected_by === 'owner' ? comparison.selection_reason : undefined;
  return [choice ? `Owner choice: ${choice}` : '', note.trim() ? `Owner note: ${note.trim()}` : '']
    .filter(Boolean)
    .join('\n\n');
}
export function ReviewedDecisionForm({
  comparison,
  busy,
  blocked,
  onAccept,
  onClose,
  confirmationKey,
}: {
  comparison: ComparisonState;
  busy: boolean;
  blocked?: boolean;
  onAccept: (
    rationale: string,
    alternatives: { candidate: string; reason: string }[],
  ) => Promise<void>;
  onClose: () => void;
  confirmationKey: string;
}) {
  const [note, setNote] = useState('');
  const [confirmedKey, setConfirmedKey] = useState('');
  const confirmed = confirmedKey === confirmationKey;
  const rationale = selectionRationale(comparison, note);
  return (
    <form
      className="decision-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !blocked && confirmed && rationale) void onAccept(rationale, []);
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
      <p>Publishes the selected source after Git verification. Your recorded choice is retained.</p>
      <div>
        <button type="submit" disabled={busy || blocked || !confirmed || !rationale}>
          Publish result
        </button>
        <button type="button" className="quiet" disabled={busy} onClick={onClose}>
          Continue reviewing
        </button>
      </div>
    </form>
  );
}
