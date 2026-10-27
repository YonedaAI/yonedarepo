import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { short } from '../../lib/api';

export function ComparisonChoiceDialog({
  candidate,
  busy,
  uncertain,
  blocker,
  onChoose,
  onClose,
}: {
  candidate: Record<string, any>;
  busy: boolean;
  uncertain: boolean;
  blocker?: string;
  onChoose: (reason: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  return (
    <Dialog
      title="Use this result"
      initialFocus="textarea"
      locked={busy || uncertain}
      onClose={onClose}
    >
      <p>
        Choose revision <code>{short(candidate.revision?.commit)}</code> as the working result. The
        original alternatives stay recorded. This does not publish.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || (!uncertain && (blocker || !reason.trim()))) return;
          setError('');
          void onChoose(reason.trim())
            .then((done) => {
              if (done) onClose();
            })
            .catch((failure) => setError(failure.message));
        }}
      >
        <label>
          Why use this result?
          <textarea
            required
            maxLength={2048}
            value={reason}
            disabled={busy || uncertain}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {(error || blocker) && <p role="alert">{error || blocker}</p>}
        {uncertain && (
          <p role="status">
            Selection is unconfirmed. Check the same request before making another choice.
          </p>
        )}
        <div className="run-actions">
          <button type="submit" disabled={busy || (!uncertain && (!!blocker || !reason.trim()))}>
            {uncertain ? 'Check selection status' : 'Use this result'}
          </button>
          <button type="button" className="quiet" disabled={busy || uncertain} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
