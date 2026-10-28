import { RotateCcw, StopCircle, Trash2 } from 'lucide-react';
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
  deleteBlocker,
  onDelete,
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
  /** Why deletion is unavailable now; the control stays visible but disabled. */
  deleteBlocker?: string;
  onDelete?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
      {!reviewer && onDelete && (
        <button
          type="button"
          className="quiet"
          disabled={busy || !!deleteBlocker}
          title={deleteBlocker}
          onClick={() => setDeleting(true)}
        >
          <Trash2 size={16} />
          Delete run
        </button>
      )}
      {!reviewer && onDelete && deleteBlocker && (
        <p className="subtle delete-blocker">{deleteBlocker}</p>
      )}
      {deleting && onDelete && (
        <Dialog
          title="Delete this run?"
          locked={busy}
          initialFocus=".keep-run"
          onClose={() => setDeleting(false)}
        >
          <p>
            This permanently removes the run's results, agent logs and recorded history. Published
            source is not affected.
          </p>
          <div className="run-actions">
            <button
              type="button"
              className="quiet keep-run"
              disabled={busy}
              onClick={() => setDeleting(false)}
            >
              Keep run
            </button>
            <button
              type="button"
              disabled={busy || !!deleteBlocker}
              onClick={() => {
                setDeleting(false);
                onDelete();
              }}
            >
              Confirm delete run
            </button>
          </div>
        </Dialog>
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
