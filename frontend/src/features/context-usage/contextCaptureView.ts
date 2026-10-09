import type { ContextCitation } from '../../../../shared/context_usage';

type Capture = ContextCitation['candidates'][number];
export function captureLabel(candidate: Capture) {
  return candidate.capture_kind === 'task_contribution'
    ? 'Intermediate task source'
    : candidate.capture_kind === 'integration'
      ? 'Integrated captured revision'
      : 'Captured revision';
}
export function captureCheckNote(candidate: Capture, captures: Capture[]) {
  if (candidate.capture_kind !== 'task_contribution')
    return 'Independent evaluation pending or unavailable.';
  const included = captures.some(
    (capture) =>
      capture.capture_kind === 'integration' &&
      capture.source_handoff === candidate.id &&
      capture.evaluation,
  );
  return included
    ? 'Included in the combined integration candidate checked below. This intermediate revision has no separate evaluator result.'
    : 'Awaiting combined integration checks. This intermediate revision has no separate evaluator result.';
}
