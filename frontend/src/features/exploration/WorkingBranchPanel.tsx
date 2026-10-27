import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { runHasActiveAttempts } from './runControlState';
import { runWorkingBranch, type WorkingBranch } from './workingBranchView';

export function WorkingBranchPanel({
  snapshot,
  run,
  reviewer,
  busy,
  canStart,
  onContinue,
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
  reviewer: boolean;
  busy: boolean;
  canStart: boolean;
  onContinue?: (branch: WorkingBranch) => void;
}) {
  if (!run.working_branch_id) return null;
  const branch = runWorkingBranch(snapshot, run);
  if (!branch)
    return (
      <aside className="working-branch-panel" role="status">
        Working branch {run.working_branch_id} is not included in this response. Refresh before
        continuing.
      </aside>
    );
  // Any run still working on this branch blocks continuation, not only the run on screen.
  const active = snapshot.runs.some(
    (other) =>
      (other.id === run.id || other.working_branch_id === run.working_branch_id) &&
      runHasActiveAttempts(snapshot, other),
  );
  return (
    <aside className="working-branch-panel" aria-label="Working branch">
      <h3>{branch.latest_candidate_id ? 'Checked working branch' : 'Working branch'}</h3>
      <p>
        <code>{branch.id}</code> · working head <code>{short(branch.working_commit)}</code> ·
        version {branch.version}
      </p>
      <p>
        {branch.working_commit === snapshot.repository.published_commit ? (
          `This ${branch.latest_candidate_id ? 'checked' : 'working'} revision matches your published source. Continue from it to make the next change.`
        ) : (
          <>
            Canonical source{' '}
            <code>
              {short(snapshot.repository.published_commit ?? snapshot.repository.head_commit)}
            </code>{' '}
            is separate. Checked work has not been published by advancing this branch.
          </>
        )}
      </p>
      {!branch.latest_candidate_id && <p>No checked candidate has advanced this branch yet.</p>}
      {!reviewer && onContinue && (
        <button
          type="button"
          className={branch.latest_candidate_id ? 'primary' : 'quiet'}
          disabled={busy || !canStart || active || branch.status !== 'active'}
          onClick={() => onContinue(branch)}
        >
          {branch.latest_candidate_id ? 'Continue checked work' : 'Open working brief'}
        </button>
      )}
      {active && <p>Finish or cancel the active work on this branch before continuing.</p>}
      {branch.status !== 'active' && <p>Recorded branch status: {branch.status}.</p>}
      <p className="subtle">
        Continuation opens an editable brief with this working-head lease. Review and approve it
        before agents start.
      </p>
    </aside>
  );
}
