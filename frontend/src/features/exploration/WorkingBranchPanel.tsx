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
  const active = runHasActiveAttempts(snapshot, run);
  return (
    <aside className="working-branch-panel" aria-label="Working branch">
      <h3>{branch.latest_candidate_id ? 'Checked working branch' : 'Working branch'}</h3>
      <p>
        <code>{branch.id}</code> · working head <code>{short(branch.working_commit)}</code> ·
        version {branch.version}
      </p>
      <p>
        Canonical source{' '}
        <code>
          {short(snapshot.repository.published_commit ?? snapshot.repository.head_commit)}
        </code>{' '}
        is separate. Checked work has not been published by advancing this branch.
      </p>
      {!branch.latest_candidate_id && <p>No checked candidate has advanced this branch yet.</p>}
      {!reviewer && onContinue && (
        <button
          type="button"
          className="quiet"
          disabled={busy || !canStart || active || branch.status !== 'active'}
          onClick={() => onContinue(branch)}
        >
          {branch.latest_candidate_id ? 'Continue checked work' : 'Open working brief'}
        </button>
      )}
      {active && <p>Finish or cancel this run’s active attempts before continuing.</p>}
      {branch.status !== 'active' && <p>Recorded branch status: {branch.status}.</p>}
      <p className="subtle">
        Continuation opens an editable brief with this working-head lease. Review and approve it
        before agents start.
      </p>
    </aside>
  );
}
