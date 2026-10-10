import { RotateCcw, StopCircle } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { canCancelRun } from './runControlState';

export function RunControls({
  reviewer = false,
  run,
  busy,
  canStart,
  activeAttempts,
  hasRoots,
  supportsRestart,
  onRestart,
  onCancel,
}: {
  reviewer?: boolean;
  run: Record<string, any>;
  busy: boolean;
  canStart: boolean;
  activeAttempts: boolean;
  hasRoots: boolean;
  supportsRestart: boolean;
  onRestart: () => void;
  onCancel: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="run-controls">
      {!reviewer && (
        <button
          type="button"
          className="quiet"
          disabled={!canStart || activeAttempts || !hasRoots || !supportsRestart}
          title={
            !supportsRestart
              ? 'Restart is unavailable until this deployment is upgraded'
              : activeAttempts
                ? 'Finish or cancel the previous attempts before restarting'
                : undefined
          }
          onClick={onRestart}
        >
          <RotateCcw size={16} />
          Restart run
        </button>
      )}
      {canCancelRun(run, activeAttempts) && (
        <button type="button" className="quiet" disabled={busy} onClick={() => setConfirming(true)}>
          <StopCircle size={16} />
          Cancel run
        </button>
      )}
      {confirming && (
        <Dialog
          title="Cancel this run?"
          locked={busy}
          initialFocus=".keep-running"
          onClose={() => setConfirming(false)}
        >
          <p>
            This stops active agents and pending work for this run. Captured revisions and recorded
            evidence remain available in history.
          </p>
          <div className="run-actions">
            <button
              type="button"
              className="quiet keep-running"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep running
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onCancel();
              }}
            >
              Confirm cancel run
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
