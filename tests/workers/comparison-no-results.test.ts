import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { workspace } from '../../cloudflare/worker/workspace';
import {
  bindings,
  call,
  checkedBuilder,
  newCompare,
  owner,
  runId,
} from './comparison-review-fixture';

afterEach(reset);

it('skips paid review when both builders fail without a checked result', async () => {
  await newCompare();
  const before = await call({ op: 'snapshot' });
  const spending = await workspace(bindings, owner, { op: 'workspace_spend_status' });
  for (const index of [1, 2]) {
    const job = await call({ op: 'claim', job_id: `job:${runId}:agent-${index}` });
    await call({ op: 'fail', job_id: job.id, epoch: job.epoch, retryable: false,
      error: 'Synthetic builder failure before source capture' });
  }
  const after = await call({ op: 'snapshot' });
  expect(after.executions.filter((execution: { role: string }) => execution.role === 'reviewer')).toEqual([]);
  const run = after.runs.find((item: { id: string }) => item.id === runId);
  expect(run.comparison.reviewer_status).toBe('skipped');
  expect(run.comparison.review_skip_reason).toMatchObject({ code: 'NO_CHECKED_RESULTS', authority: 'platform' });
  expect(run.model_requests).toBe(0);
  expect(run.model_budgets).toEqual(before.runs[0].model_budgets);
  expect(after.repository).toEqual(before.repository);
  expect(await workspace(bindings, owner, { op: 'workspace_spend_status' })).toEqual(spending);
});

it('waits for pending work and still reviews an eligible result when the other builder fails', async () => {
  await newCompare();
  await checkedBuilder(1, 'b'.repeat(40));
  const pending = await call({ op: 'run_detail', run_id: runId });
  expect(pending.run.comparison.review_execution_id).toBeFalsy();
  expect(pending.run.comparison.reviewer_status).not.toBe('skipped');
  const other = await call({ op: 'claim', job_id: `job:${runId}:agent-2` });
  await call({ op: 'fail', job_id: other.id, epoch: other.epoch, retryable: false,
    error: 'Synthetic second builder failure' });
  const detail = await call({ op: 'run_detail', run_id: runId });
  expect(detail.run.comparison.status).toBe('reviewing');
  expect(detail.run.comparison.review_execution_id).toBeTruthy();
  expect(detail.candidates.some((candidate: { status: string }) => candidate.status === 'eligible')).toBe(true);
});
