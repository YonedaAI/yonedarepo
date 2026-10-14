import type { Repository } from '../../lib/types';

/**
 * Presentation guard for "Retry publication": the pending decision reported a conflict while
 * the remote still held the head recorded at decision time. The ledger re-observes and decides.
 */
export function retryablePublication(repository: Repository, decisions: Record<string, any>[]) {
  if (repository.status !== 'blocked' || !repository.pending) return undefined;
  const decision = decisions.find((item) => item.id === repository.pending);
  if (decision?.status !== 'publication_conflict') return undefined;
  const recorded = decision.published_before ?? repository.published_commit;
  const observed = decision.observed?.observed;
  return typeof observed === 'string' && observed === recorded ? decision : undefined;
}
