import type { Snapshot } from '../../lib/types';

type RecordValue = Record<string, any>;

/** The run's selection or publication decision; owner rejections are separate history. */
export function activeDecision(snapshot: Snapshot, run: RecordValue) {
  return snapshot.decisions.find((item) => item.run_id === run.id && item.status !== 'rejected');
}

/** The recorded owner rejection of this exact result, if any. */
export function rejectionOf(snapshot: Snapshot, candidate?: RecordValue) {
  if (!candidate) return undefined;
  return snapshot.decisions.find(
    (item) => item.status === 'rejected' && item.candidate === candidate.id,
  );
}

/** Results of this run that are no longer current, newest first. They stay inspectable. */
export function supersededResults(snapshot: Snapshot, run: RecordValue, current: RecordValue[]) {
  const ids = new Set(current.map((candidate) => candidate.id));
  return snapshot.candidates
    .filter((candidate) => candidate.run_id === run.id && !ids.has(candidate.id))
    .reverse();
}

export type RecordedRationale = { id: string; text: string; source: string };

/**
 * Rationale is only what agents recorded: handoff assertions from the execution that produced
 * this result, then from the run's integrator task. Nothing is generated here.
 */
export function recordedRationale(snapshot: Snapshot, run: RecordValue, candidate: RecordValue) {
  const handoffs = (snapshot.team_handoffs ?? []).filter(
    (item) =>
      item.run_id === run.id &&
      item.authority === 'assertion' &&
      typeof item.summary === 'string' &&
      item.summary.trim(),
  );
  const own = handoffs.filter((item) => item.execution_id === candidate.execution);
  const integrator = (snapshot.team_tasks ?? []).find(
    (task) => task.run_id === run.id && task.role === 'integrator',
  );
  const chosen = own.length
    ? own
    : handoffs.filter((item) => integrator && item.task_id === integrator.task_id);
  return chosen.map(
    (item): RecordedRationale => ({
      id: item.id,
      text: item.summary,
      source:
        candidate.conflict_id && own.length ? 'Conflict resolver handoff' : 'Integrator handoff',
    }),
  );
}
