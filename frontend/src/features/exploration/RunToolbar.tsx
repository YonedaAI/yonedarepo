import { Plus } from 'lucide-react';
import type { Snapshot } from '../../lib/types';

export function RunToolbar({
  canStart,
  onNewRun,
}: {
  reviewer?: boolean;
  snapshot: Snapshot;
  canStart: boolean;
  onNewRun: () => void;
}) {
  return (
    <div className="runs-toolbar">
      <div>
        <h1>Development runs</h1>
        <p>Describe a change. Build together, then review the result.</p>
      </div>
      <button type="button" className="primary" disabled={!canStart} onClick={onNewRun}>
        <Plus size={17} />
        Start a Run
      </button>
    </div>
  );
}
