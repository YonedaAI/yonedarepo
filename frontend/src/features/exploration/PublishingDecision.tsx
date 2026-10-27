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
  async function accept(rationale: string, alternatives: { candidate: string; reason: string }[]) {
    if (blocker || !chosen) return;
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
      {(error || blocker) && (
        <p role="alert" className="form-error">
          {error || blocker}
        </p>
      )}
      {comparison?.selection_reason ? (
        <ReviewedDecisionForm
          comparison={comparison}
          confirmationKey={JSON.stringify([
            chosen?.id,
            chosen?.revision,
            chosen?.evaluation,
            comparison.selection_version,
          ])}
          busy={busy}
          blocked={!!blocker}
          onAccept={accept}
          onClose={onClose}
        />
      ) : (
        <DecisionForm
          busy={busy}
          blocked={!!blocker}
          alternatives={candidates.filter((candidate) => candidate.id !== chosen?.id)}
          onClose={onClose}
          onAccept={accept}
        />
      )}
    </Dialog>
  );
}
