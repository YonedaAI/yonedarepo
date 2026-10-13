import type { Json } from './types';

export const comparisonReviewAttempt = (job: Json): boolean =>
  job.payload?.review_only === true ||
  job.payload?.comparison_review === true ||
  job.payload?.execution?.comparison_role === 'reviewer';

export function assertComparisonReview(job: Json) {
  const payload = job.payload;
  const frozen = payload?.comparison_manifest;
  if (
    job.kind !== 'agent' ||
    payload?.review_only !== true ||
    payload?.comparison_review !== true ||
    payload?.execution?.comparison_role !== 'reviewer' ||
    frozen?.version !== 1 ||
    frozen.approval_id !== payload.execution.comparison_approval_id ||
    typeof frozen.manifest_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(frozen.manifest_digest)
  )
    throw Object.assign(new Error('Comparison review scope is unavailable'), { code: 'FORBIDDEN' });
  return frozen;
}
