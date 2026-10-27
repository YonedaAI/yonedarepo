import type { Snapshot } from '../../lib/types';

/** A run's captured results. A team's one result is its team branch. */
export function runCandidates(snapshot: Snapshot, run?: Record<string, any>) {
  return snapshot.candidates.filter((candidate) => candidate.run_id === run?.id);
}
