import type { Snapshot } from '../../lib/types';
import { isSandboxTeam } from './sandboxActivityView';

type RunRecord = Record<string, any>;
export function integratedExecutions(snapshot: Snapshot, run: RunRecord) {
  return snapshot.executions.filter(
    (execution) =>
      execution.run_id === run.id &&
      execution.role === 'coding' &&
      execution.team_role === 'integrator',
  );
}
/** Retries reuse the integrator execution; its task row names the current captured candidate. */
export function runCandidates(snapshot: Snapshot, run?: RunRecord) {
  const candidates = snapshot.candidates.filter((candidate) => candidate.run_id === run?.id);
  // A sandbox team's one candidate is its team branch; it has no integrator task.
  if (run?.mode !== 'collaborate' || isSandboxTeam(run)) return candidates;
  const task = (snapshot.team_tasks ?? []).find(
    (item) => item.run_id === run.id && item.role === 'integrator',
  );
  // A recorded conflict resolution supersedes the integrated result it reconciled.
  const resolved = candidates.filter((candidate) => candidate.conflict_id).reverse();
  const integrated = candidates.filter(
    (candidate) =>
      candidate.id === task?.candidate_id && candidate.execution === task?.execution_id,
  );
  // Show one result per run: once reconciled, the earlier integration stays in history only.
  return resolved.length ? resolved.slice(0, 1) : integrated;
}
