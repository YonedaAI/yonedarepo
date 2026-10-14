import type { ComparisonState } from '../../lib/comparison';

/** A platform receipt records a skip; missing candidates alone do not. */
export function comparisonSkipNotice(comparison?: ComparisonState) {
  if (
    comparison?.version !== 1 ||
    comparison.reviewer_status !== 'skipped' ||
    comparison.review_skip_reason?.authority !== 'platform'
  )
    return undefined;
  if (comparison.review_skip_reason.code === 'NO_CHECKED_RESULTS')
    return {
      code: 'NO_CHECKED_RESULTS',
      title: 'Review skipped — no checked results',
      detail:
        'No checked result is eligible for review. Inspect the builder, capture and check failures. No result is ready to publish.',
    };
  const recovery = comparison.verification_recovery;
  if (
    comparison.review_skip_reason.code === 'CAPTURE_RECOVERY_CHECK_ONLY' &&
    recovery?.version === 1 &&
    recovery.automatic_review === false &&
    recovery.authority === 'owner_verification_recovery' &&
    recovery.request_id
  )
    return {
      code: 'CAPTURE_RECOVERY_CHECK_ONLY',
      title: 'Review skipped — capture verification only',
      detail:
        'This owner-approved recovery captured and checked the saved source without another automatic review. Inspect the exact current checks and choose an eligible result manually.',
    };
  return undefined;
}
