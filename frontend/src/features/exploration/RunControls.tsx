import { RotateCcw, StopCircle } from 'lucide-react';
import { canCancelRun } from './runControlState';

export function RunControls({
  run,
  busy,
  canStart,
  activeAttempts,
  hasRoots,
  supportsRestart,
  onRestart,
  onCancel,
}: {
  run: Record<string, any>;
  busy: boolean;
  canStart: boolean;
  activeAttempts: boolean;
  hasRoots: boolean;
  supportsRestart: boolean;
  onRestart: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="run-controls">
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
      {canCancelRun(run, activeAttempts) && (
        <button type="button" className="quiet" disabled={busy} onClick={onCancel}>
          <StopCircle size={16} />
          Cancel run
        </button>
      )}
    </div>
  );
}
