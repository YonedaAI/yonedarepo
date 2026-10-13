import { Plus } from 'lucide-react';
import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { runAgentLimits } from './agentLimits';
import { hasPublishedWork } from './runDefaults';
import { supportsWorkingBranches, workingBranches } from './workingBranchView';

export function RunToolbar({
  reviewer = false,
  snapshot,
  canStart,
  onNewRun,
}: {
  reviewer?: boolean;
  snapshot: Snapshot;
  canStart: boolean;
  onNewRun: () => void;
}) {
  const repo = snapshot.repository;
  const updating = hasPublishedWork(snapshot);
  const supportsSingle = runAgentLimits(snapshot).min_root_agents === 1;
  const branches = workingBranches(snapshot);
  const branchSupport = supportsWorkingBranches(snapshot);
  return (
    <>
      <div className="runs-toolbar">
        <div>
          <h1>Development runs</h1>
          <p>
            {supportsSingle
              ? 'Build together or compare approaches. Review and decide what ships.'
              : 'Compare independent approaches. Decide what ships.'}
          </p>
        </div>
        {!reviewer && (
          <button
            type="button"
            className={snapshot.runs.length ? 'quiet' : undefined}
            disabled={!canStart}
            onClick={onNewRun}
          >
            <Plus size={17} />
            {branchSupport
              ? branches.some((branch) => branch.status === 'active')
                ? 'Continue working branch'
                : 'Create working branch'
              : updating
                ? repo.site
                  ? 'Update website'
                  : 'Update project'
                : 'New run'}
          </button>
        )}
      </div>
      {branchSupport ? (
        <p className="subtle">
          New work starts on a working branch. Checked results advance its head; canonical source
          changes after a recorded publishing decision.
        </p>
      ) : (
        updating && (
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
        )
      )}
    </>
  );
}
