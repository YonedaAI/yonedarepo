import { Plus } from 'lucide-react';
import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { runAgentLimits } from './agentLimits';
import { hasPublishedWork } from './runDefaults';

export function RunToolbar({
  snapshot,
  canStart,
  onNewRun,
}: {
  snapshot: Snapshot;
  canStart: boolean;
  onNewRun: () => void;
}) {
  const repo = snapshot.repository;
  const updating = hasPublishedWork(snapshot);
  const supportsSingle = runAgentLimits(snapshot).min_root_agents === 1;
  return (
    <>
      <div className="runs-toolbar">
        <div>
          <h1>Development runs</h1>
          <p>
            {supportsSingle
              ? 'Build with one agent or compare independent approaches. Decide what ships.'
              : 'Compare independent approaches. Decide what ships.'}
          </p>
        </div>
        <button type="button" disabled={!canStart} onClick={onNewRun}>
          <Plus size={17} />
          {updating ? (repo.site ? 'Update website' : 'Update project') : 'New run'}
        </button>
      </div>
      {updating && (
        <p className="subtle">
          Updates start from current canonical source <code>{short(repo.head_commit)}</code>. The
          published approach and approved context are carried forward for review.
          {repo.site && repo.site.commit !== repo.head_commit && (
            <>
              {' '}
              Currently hosted revision: <code>{short(repo.site?.commit ?? '')}</code>.
            </>
          )}
        </p>
      )}
      <p className="fixture-scope">
        Independent evaluator: {repo.policy?.suite ?? 'configured policy'}
      </p>
    </>
  );
}
