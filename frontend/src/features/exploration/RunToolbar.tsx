import { Plus } from 'lucide-react';
import type { Snapshot } from '../../lib/types';

export function RunToolbar({
  canStart,
  onNewRun,
  onGuidedDemo,
}: {
  reviewer?: boolean;
  snapshot: Snapshot;
  canStart: boolean;
  onNewRun: () => void;
  onGuidedDemo?: () => void;
}) {
  return (
    <div className="runs-toolbar">
      <div>
        <h1>Development runs</h1>
        <p>Describe a change. Build together, then review the result.</p>
      </div>
      <div className="guided-launch-actions">
        {onGuidedDemo && (
          <button type="button" className="quiet" onClick={onGuidedDemo}>
            Try guided demo
          </button>
        )}
        <button type="button" className="primary" disabled={!canStart} onClick={onNewRun}>
          <Plus size={17} />
          Start a Run
        </button>
      </div>
    </div>
  );
}
