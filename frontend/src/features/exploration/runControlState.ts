/** One failed team task does not imply all parallel attempts stopped. */
export function canCancelRun(run: Record<string, any>, activeAttempts: boolean) {
  if (['accepted', 'cancelled'].includes(run.status)) return false;
  return run.status !== 'failed' || activeAttempts || run.mode === 'collaborate';
}

import type { Snapshot } from '../../lib/types';

export function runHasActiveAttempts(snapshot: Snapshot, run?: Record<string, any>) {
  return (
    ['planning', 'coordinating', 'awaiting_intent'].includes(run?.status) ||
    snapshot.executions.some(
      (execution) =>
        execution.run_id === run?.id &&
        ['queued', 'running', 'capturing', 'evaluating'].includes(execution.status),
    )
  );
}

/** Why the owner cannot delete this run yet, or undefined once deletion is allowed. */
export function runDeleteBlocker(snapshot: Snapshot, run: Record<string, any>) {
  if (
    !['accepted', 'cancelled', 'failed', 'ready'].includes(run.status) ||
    runHasActiveAttempts(snapshot, run)
  )
    return 'Cancel the run before deleting it.';
  const pending = snapshot.repository.pending;
  if (pending && snapshot.decisions.some((item) => item.id === pending && item.run_id === run.id))
    return 'Wait for publication to finish before deleting this run.';
  return undefined;
}
