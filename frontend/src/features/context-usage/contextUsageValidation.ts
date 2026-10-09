import type { ContextUsage } from '../../../../shared/context_usage';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const nullableText = (value: unknown) => value === null || text(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown) => integer(value) && value <= 8_640_000_000_000_000;
const nullableInteger = (value: unknown) => value === null || integer(value);
const list = (value: unknown, valid: (item: unknown) => boolean) =>
  Array.isArray(value) && value.every(valid);

function target(value: unknown) {
  return (
    object(value) &&
    ['id', 'kind', 'label', 'authority'].every((key) => text(value[key])) &&
    (value.digest === undefined || nullableText(value.digest)) &&
    (value.relation === undefined || nullableText(value.relation))
  );
}
function revision(value: unknown) {
  return object(value) && text(value.repository) && text(value.commit);
}
function check(value: unknown) {
  return object(value) && ['name', 'status', 'detail'].every((key) => text(value[key]));
}
function evaluation(value: unknown) {
  return (
    object(value) &&
    value.authority === 'checked_revision' &&
    ['candidate_id', 'execution_id', 'evaluation_id', 'evidence', 'policy'].every((key) =>
      text(value[key]),
    ) &&
    revision(value.revision) &&
    list(value.checks, check)
  );
}
function candidate(value: unknown) {
  return (
    object(value) &&
    text(value.id) &&
    text(value.capture_job_id) &&
    (value.capture_kind === undefined ||
      value.capture_kind === null ||
      ['task_contribution', 'integration'].includes(String(value.capture_kind))) &&
    (value.source_handoff === undefined || nullableText(value.source_handoff)) &&
    revision(value.revision) &&
    (value.evaluation === null || evaluation(value.evaluation))
  );
}
function citation(value: unknown) {
  return (
    object(value) &&
    value.authority === 'assertion' &&
    text(value.record_id) &&
    timestamp(value.at) &&
    nullableInteger(value.seq) &&
    nullableInteger(value.epoch) &&
    nullableText(value.execution_id) &&
    list(value.targets, target) &&
    list(value.candidates, candidate)
  );
}
function access(value: unknown) {
  return (
    object(value) &&
    integer(value.seq) &&
    timestamp(value.at) &&
    text(value.call_id) &&
    text(value.tool) &&
    ['returned', 'opened'].includes(String(value.stage)) &&
    ['execution_id', 'job_id', 'session_id'].every((key) => nullableText(value[key])) &&
    nullableInteger(value.epoch) &&
    list(value.targets, target)
  );
}
function assignment(value: unknown) {
  return (
    object(value) &&
    text(value.execution_id) &&
    value.stage === 'assigned' &&
    list(value.targets, target)
  );
}

export function validContextUsage(value: unknown): value is ContextUsage {
  return (
    object(value) &&
    value.version === 1 &&
    nullableText(value.run_id) &&
    object(value.coverage) &&
    ['recorded', 'partial', 'unavailable'].includes(String(value.coverage.status)) &&
    text(value.coverage.reason) &&
    timestamp(value.coverage.activated_at) &&
    object(value.counts) &&
    ['assigned', 'returned', 'opened', 'cited', 'checked', 'read_calls'].every((key) =>
      integer((value.counts as Record<string, unknown>)[key]),
    ) &&
    list(value.entries, access) &&
    list(value.assigned, assignment) &&
    list(value.citations, citation) &&
    list(value.checked, evaluation) &&
    integer(value.next_cursor) &&
    typeof value.has_more === 'boolean' &&
    typeof value.citations_truncated === 'boolean'
  );
}
