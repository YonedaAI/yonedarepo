import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { short } from '../../lib/api';
import { DecisionForm } from './DecisionForm';

export function PublishingDecision({
  chosen,
  candidates,
  busy,
  blocker,
  onClose,
  onAccept,
}: {
  chosen?: Record<string, any>;
  candidates: Record<string, any>[];
  busy: boolean;
  blocker?: string;
  onClose: () => void;
  onAccept: (
    candidate: string,
    rationale: string,
    alternatives: { candidate: string; reason: string }[],
  ) => Promise<boolean>;
}) {
  const [error, setError] = useState('');
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
      <DecisionForm
        busy={busy}
        blocked={!!blocker}
        alternatives={candidates.filter((candidate) => candidate.id !== chosen?.id)}
        onClose={onClose}
        onAccept={async (rationale, alternatives) => {
          if (blocker || !chosen) return;
          setError('');
          try {
            if (await onAccept(chosen.id, rationale, alternatives)) onClose();
          } catch (failure) {
            setError((failure as Error).message);
          }
        }}
      />
    </Dialog>
  );
}
