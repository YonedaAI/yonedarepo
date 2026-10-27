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
