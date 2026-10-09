/** One failed team task does not imply all parallel attempts stopped. */
export function canCancelRun(run: Record<string, any>, activeAttempts: boolean) {
  if (['accepted', 'cancelled'].includes(run.status)) return false;
  return run.status !== 'failed' || activeAttempts || run.mode === 'collaborate';
}

import type { Snapshot } from '../../lib/types';

export function runHasActiveAttempts(snapshot: Snapshot, run?: Record<string, any>) {
  return (
    run?.status === 'planning' ||
    snapshot.executions.some(
      (execution) =>
        execution.run_id === run?.id &&
        ['queued', 'running', 'capturing', 'evaluating'].includes(execution.status),
    )
  );
}
