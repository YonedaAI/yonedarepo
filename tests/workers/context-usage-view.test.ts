import { expect, it } from 'vitest';
import type { ContextUsage } from '../../shared/context_usage';
import { contextUsageMetric, contextUsagePath, isContextUsage } from '../../frontend/src/features/context-usage/contextUsageView';
import { captureCheckNote, captureLabel } from '../../frontend/src/features/context-usage/contextCaptureView';

const usage: ContextUsage = {
  version: 1, run_id: 'run', coverage: { status: 'unavailable', reason: 'Historical access was not tracked', activated_at: 0 },
  counts: { assigned: 2, returned: 0, opened: 0, cited: 1, checked: 1, read_calls: 0 },
  assigned: [], entries: [], citations: [], checked: [], next_cursor: 0, has_more: false, citations_truncated: false,
};

it('does not turn missing historical access tracking into zero reads or erase recorded lineage', () => {
  expect(contextUsageMetric(usage, 'opened').value).toBe('—');
  expect(contextUsageMetric(usage, 'returned').value).toBe('—');
  expect(contextUsageMetric(usage, 'assigned').value).toBe('2');
  expect(contextUsageMetric(usage, 'cited').value).toBe('1');
  expect(contextUsageMetric(usage, 'checked').value).toBe('1');
  const partial = { ...usage, coverage: { ...usage.coverage, status: 'partial' as const }, counts: { ...usage.counts, opened: 3 } };
  expect(contextUsageMetric(partial, 'opened')).toEqual({ value: '3', note: 'recorded · incomplete tracking' });
  const recorded = { ...usage, coverage: { ...usage.coverage, status: 'recorded' as const } };
  expect(contextUsageMetric(recorded, 'opened').value).toBe('0');
});

it('keeps run, agent, attempt and pagination scope explicit and rejects invalid attempts', () => {
  const path = contextUsagePath('repo/id', 'run', 'agent+id', '2', 91);
  const url = new URL(`https://local/api/${path}`);
  expect(url.pathname).toContain('repo%2Fid');
  expect(Object.fromEntries(url.searchParams)).toEqual({ run_id: 'run', cursor: '91', limit: '30', execution_id: 'agent+id', epoch: '2' });
  expect(contextUsagePath('repo', 'run', '', '0', 0)).toBeNull();
  expect(contextUsagePath('repo', 'run', '', '1.5', 0)).toBeNull();
});

it('rejects evidence from another run and malformed count or paging responses', () => {
  expect(isContextUsage(usage, 'run')).toBe(true);
  expect(isContextUsage(usage, 'other')).toBe(false);
  expect(isContextUsage({ ...usage, counts: { ...usage.counts, opened: -1 } }, 'run')).toBe(false);
  expect(isContextUsage({ ...usage, next_cursor: -1 }, 'run')).toBe(false);
});

it('accepts exact ledger capture and evaluation identifiers and rejects malformed nested lineage', () => {
  const evaluation = {
    candidate_id: 'candidate', execution_id: 'agent', evaluation_id: 'evaluation',
    revision: { repository: 'source', commit: 'exact-commit' }, evidence: 'digest',
    policy: 'policy-digest', checks: [{ name: 'html', status: 'passed', detail: 'Exact revision checked' }],
    authority: 'checked_revision' as const,
  };
  const target = { id: 'context', digest: null, label: 'Decision', kind: 'decision', authority: 'assertion', relation: 'supports' };
  const citation = {
    record_id: 'assertion', seq: 17, at: 1000, epoch: null, execution_id: 'agent',
    authority: 'assertion' as const, targets: [target],
    candidates: [{ id: 'candidate', capture_job_id: 'capture:agent', revision: evaluation.revision, evaluation }],
  };
  const recorded = { ...usage, citations: [citation], checked: [evaluation] };
  expect(isContextUsage(recorded, 'run')).toBe(true);
  expect(isContextUsage({ ...recorded, citations: [{ ...citation, targets: [null] }] }, 'run')).toBe(false);
  expect(isContextUsage({ ...recorded, checked: [{ ...evaluation, revision: null }] }, 'run')).toBe(false);
  expect(isContextUsage({ ...usage, citations_truncated: 'false' }, 'run')).toBe(false);
});

it('preserves intermediate capture versus exact integrated revision checks', () => {
  const intermediate = { id: 'handoff:search', capture_job_id: 'capture:search', revision: { repository: 'task', commit: 'worker' }, capture_kind: 'task_contribution' as const, evaluation: null };
  const integrated = { id: 'combined', capture_job_id: 'capture:integrate', revision: { repository: 'final', commit: 'combined' }, capture_kind: 'integration' as const, source_handoff: intermediate.id, evaluation: { candidate_id: 'combined', execution_id: 'integrator', evaluation_id: 'checks', revision: { repository: 'final', commit: 'combined' }, evidence: 'digest', policy: 'policy', checks: [], authority: 'checked_revision' as const } };
  const citation = { record_id: 'assertion', seq: 1, at: 1, epoch: 1, execution_id: 'search', authority: 'assertion' as const, targets: [], candidates: [intermediate, integrated] };
  expect(isContextUsage({ ...usage, citations: [citation] }, 'run')).toBe(true);
  expect(captureLabel(intermediate)).toBe('Intermediate task source');
  expect(captureLabel(integrated)).toBe('Integrated captured revision');
  expect(captureCheckNote(intermediate, [intermediate])).toContain('Awaiting combined');
  expect(captureCheckNote(intermediate, [intermediate, integrated])).toContain('no separate evaluator');
  expect(captureCheckNote(intermediate, [intermediate, { ...integrated, source_handoff: 'unrelated' }])).toContain('Awaiting combined');
  expect(isContextUsage({ ...usage, citations: [{ ...citation, candidates: [{ ...intermediate, capture_kind: 'verified_assertion' }] }] }, 'run')).toBe(false);
});
