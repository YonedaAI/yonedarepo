import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { short } from '../../lib/api';

const MAX_REASON = 2000;

/** Rejection records an immutable owner decision; nothing is published and canonical is unchanged. */
export function RejectDialog({
  candidate,
  busy,
  onClose,
  onReject,
}: {
  candidate: Record<string, any>;
  busy: boolean;
  onClose: () => void;
  onReject: (candidate: string, reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const trimmed = reason.trim();
  return (
    <Dialog initialFocus="textarea" title="Reject this result" onClose={onClose} locked={busy}>
      <p className="selection-summary">
        <strong>{candidate.strategy ?? 'Captured result'}</strong>
        <br />
        Exact revision <code>{short(candidate.revision?.commit)}</code>
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <form
        className="decision-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!trimmed) return;
          setError('');
          try {
            if (await onReject(candidate.id, trimmed)) onClose();
          } catch (failure) {
            setError((failure as Error).message);
          }
        }}
      >
        <label htmlFor="rejection-reason">Why reject this result?</label>
        <textarea
          id="rejection-reason"
          value={reason}
          maxLength={MAX_REASON}
          required
          onChange={(event) => setReason(event.target.value)}
          placeholder="Record what is wrong so the next attempt can address it."
        />
        <p>
          Records your decision with this reason. Nothing is published and the canonical source
          stays unchanged. A rejected result cannot be published later.
        </p>
        <div>
          <button type="submit" className="danger-button" disabled={busy || !trimmed}>
            Reject result
          </button>
          <button type="button" className="quiet" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
