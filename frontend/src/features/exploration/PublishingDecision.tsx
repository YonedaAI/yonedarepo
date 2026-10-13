import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { short } from '../../lib/api';
import type { ComparisonState } from '../../lib/comparison';
import { DecisionForm } from './DecisionForm';
import { ReviewedDecisionForm } from './ReviewedDecisionForm';

export function PublishingDecision({
  chosen,
  candidates,
  busy,
  blocker,
  onClose,
  onAccept,
  comparison,
}: {
  chosen?: Record<string, any>;
  candidates: Record<string, any>[];
  busy: boolean;
  blocker?: string;
  onClose: () => void;
  comparison?: ComparisonState;
  onAccept: (
    candidate: string,
    rationale: string,
    alternatives: { candidate: string; reason: string }[],
  ) => Promise<boolean>;
}) {
  const [error, setError] = useState('');
  const missingReview =
    !!comparison?.latest_review_id && !comparison.latest_review && !comparison.selection_reason;
  const blockedReason =
    blocker ??
    (missingReview
      ? 'The recorded reviewer assessment is unavailable. Refresh before publishing.'
      : undefined);
  async function accept(rationale: string, alternatives: { candidate: string; reason: string }[]) {
    if (blockedReason || !chosen) return;
    setError('');
    try {
      if (await onAccept(chosen.id, rationale, alternatives)) onClose();
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  return (
    <Dialog
      initialFocus="textarea"
      title="Record publishing decision"
      onClose={onClose}
      locked={busy}
    >
      <p className="selection-summary">
        <strong>{chosen?.strategy}</strong>
        <br />
        Exact revision <code>{short(chosen?.revision?.commit)}</code>
      </p>
      {(error || blockedReason) && (
        <p role="alert" className="form-error">
          {error || blockedReason}
        </p>
      )}
      {comparison?.latest_review || comparison?.selection_reason ? (
        <ReviewedDecisionForm
          comparison={comparison}
          candidate={chosen?.id ?? ''}
          confirmationKey={JSON.stringify([
            chosen?.id,
            chosen?.revision,
            chosen?.evaluation,
            comparison.selection_version,
            comparison.latest_review_id,
          ])}
          busy={busy}
          blocked={!!blockedReason}
          onAccept={accept}
          onClose={onClose}
        />
      ) : (
        <DecisionForm
          busy={busy}
          blocked={!!blockedReason}
          alternatives={candidates.filter((candidate) => candidate.id !== chosen?.id)}
          onClose={onClose}
          onAccept={accept}
        />
      )}
    </Dialog>
  );
}
