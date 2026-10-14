import { ArrowLeft, Plus } from 'lucide-react';
import type { Snapshot } from '../../lib/types';

export function RunToolbar({
  canStart,
  onNewRun,
  onGuidedDemo,
  onGuidedContinue,
}: {
  reviewer?: boolean;
  snapshot: Snapshot;
  canStart: boolean;
  onNewRun: () => void;
  onGuidedDemo?: () => void;
  /** Present when this repository already has a guided session; replaces the demo launcher. */
  onGuidedContinue?: () => void;
}) {
  return (
    <div className="runs-toolbar">
      <div>
        <h1>Development runs</h1>
        <p>Describe a change. Build together, then review the result.</p>
      </div>
      <div className="guided-launch-actions">
        {onGuidedContinue ? (
          <button type="button" className="text-button guided-back" onClick={onGuidedContinue}>
            <ArrowLeft size={15} aria-hidden="true" />
            Back to guided demo
          </button>
        ) : (
          onGuidedDemo && (
            <button type="button" className="quiet" onClick={onGuidedDemo}>
              Try guided demo
            </button>
          )
        )}
        <button type="button" className="primary" disabled={!canStart} onClick={onNewRun}>
          <Plus size={17} />
          Start a Run
        </button>
      </div>
    </div>
  );
}
