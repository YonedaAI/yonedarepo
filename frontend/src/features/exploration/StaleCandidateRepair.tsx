import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { runHasActiveAttempts } from './runControlState';

export function StaleCandidateRepair({
  reviewer = false,
  snapshot,
  run,
  busy,
  canStart,
  onRepair,
}: {
  reviewer?: boolean;
  snapshot: Snapshot;
  run: Record<string, any>;
  busy: boolean;
  canStart: boolean;
  onRepair: () => void;
}) {
  const stale = snapshot.candidates.some(
    (candidate) =>
      candidate.run_id === run.id && candidate.base?.commit !== snapshot.repository.head_commit,
  );
  const decision = snapshot.decisions.some((item) => item.run_id === run.id);
  if (reviewer || !stale || decision) return null;
  const active = runHasActiveAttempts(snapshot, run);
  const agents =
    snapshot.executions.some(
      (execution) =>
        execution.run_id === run.id && execution.role === 'coding' && !execution.parent_execution,
    ) || !!run.agents?.length;
  const supported = snapshot.capabilities?.model_budgets === 1;
  return (
    <aside className="stale-repair" aria-label="Repair stale result">
      <h3>This result is based on an older revision</h3>
      <p>
        The repository is now at <code>{short(snapshot.repository.head_commit)}</code>. Repair opens
        the existing brief in a new run from the current source, with fresh captures and independent
        checks. Review the brief and approve before agents start. The old result stays in history.
      </p>
      <button
        type="button"
        disabled={busy || !canStart || active || !agents || !supported}
        onClick={onRepair}
      >
        Repair on current revision
      </button>
      {active && <p>Finish or cancel active attempts before starting the repair.</p>}
      {!supported && <p>This deployment needs restart support before a repair can start.</p>}
      {!agents && (
        <p>No reusable agent settings were recorded. Start a new run with the same intent.</p>
      )}
      {!canStart && !active && (
        <p>The repository must be ready with no pending publication before a repair can start.</p>
      )}
    </aside>
  );
}
