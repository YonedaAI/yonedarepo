import type { Snapshot } from '../../lib/types';

type RecordValue = Record<string, any>;

/** Mirrors the ledger bound on refreshes of refreshes. */
const MAX_REFRESH_DEPTH = 3;

/**
 * Presentation guard only; the ledger revalidates every refresh link before publication.
 * Whether `candidate` is the selected comparison result or a refresh of it in this run.
 */
export function refreshesSelection(snapshot: Snapshot, run: RecordValue, candidate?: RecordValue) {
  const selected = run.comparison?.selected_candidate_id;
  let current = candidate;
  for (let depth = 0; selected && current && depth <= MAX_REFRESH_DEPTH; depth += 1) {
    if (current.run_id !== run.id) return false;
    if (current.id === selected) return true;
    const parent: string | undefined = current.refresh_of;
    current = parent
      ? snapshot.candidates.find((item) => item.id === parent && item.run_id === run.id)
      : undefined;
  }
  return false;
}

/**
 * The newest refresh of the selected comparison result, which the selection stands for once
 * it is checked: refreshing only merges the chosen change onto a newer main.
 */
export function refreshedSelection(snapshot: Snapshot, run: RecordValue) {
  const selected = run.comparison?.selected_candidate_id;
  if (!selected) return undefined;
  return [...snapshot.candidates]
    .reverse()
    .find(
      (candidate) =>
        candidate.run_id === run.id &&
        candidate.refresh_of &&
        candidate.id !== selected &&
        refreshesSelection(snapshot, run, candidate),
    );
}
