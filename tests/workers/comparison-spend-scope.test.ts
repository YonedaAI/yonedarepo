import { expect, it } from 'vitest';
import { deriveComparisonReviewer } from '../../cloudflare/worker/comparison-approval';
import { comparisonSpendMatches } from '../../cloudflare/worker/comparison-spend';
import { prepareModelRequest } from '../../cloudflare/worker/model-policy';
import type { Json } from '../../cloudflare/worker/types';
import type { WorkspaceSpendContext } from '../../cloudflare/worker/workspace-spend';

function fixture(role: string, index = 0) {
  const { _comparison_reviewer: reviewer, _comparison_reviewer_budget: budget } = deriveComparisonReviewer([{ id: 'saved', provider: 'zai', model: 'glm-5.3-flash', version: 1 }], 50000000);
  const approval = { id: 'approval', digest: 'a'.repeat(64), builders: [reviewer, { ...reviewer, connection: 'second' }], reviewer, model_budget_configs: [budget] };
  const execution = { ...(role === 'reviewer' ? reviewer : approval.builders[index]), id: 'execution', run_id: 'run', comparison_role: role, comparison_approval_id: approval.id, agent_index: index, harness: 'claude', budget: { provider: budget.provider, model: budget.model } };
  const job: Json = { id: 'job', epoch: 1, kind: 'agent', model: budget.model, payload: { execution, run: { model_budgets: [{ ...budget, max_requests: 1, requests: 1 }], comparison: { approval } } } };
  const context: WorkspaceSpendContext = { owner: 'owner', repo_id: 'repo', job_id: 'job', epoch: 1, run_id: 'run', provider: budget.provider, model: budget.model, model_budget: budget, comparison_approval_id: approval.id, comparison_approval_digest: approval.digest };
  return { job, context };
}

it('authorizes both exact frozen builder slots and same-group Auto reviewer without reallocating old budgets', () => {
  for (const [role, slot] of [['builder', 0], ['builder', 1], ['reviewer', 0], ['repair', 1]] as const) {
    const { job, context } = fixture(role, slot);
    expect(comparisonSpendMatches(context, job)).toBe(true);
    const before = structuredClone(job.payload.run);
    const result = prepareModelRequest(job, 'claude', '/v1/messages', { max_tokens: 99999 }, context);
    expect(result.body.max_tokens).toBe(4096);
    expect(job.payload.run).toEqual(before);
  }
});

it('fences model, slot, version, approval and epoch substitutions before transport', () => {
  for (const [key, value] of [['agent_index', 1], ['version', 2], ['comparison_approval_id', 'other'], ['reasoning_effort', 'max']] as const) {
    const { job, context } = fixture('builder');
    job.payload.execution[key] = value;
    expect(comparisonSpendMatches(context, job)).toBe(false);
  }
  const { job, context } = fixture('reviewer');
  expect(() => prepareModelRequest(job, 'claude', '/v1/messages', {})).toThrow('authoritative');
  expect(() => prepareModelRequest(job, 'claude', '/v1/messages', {}, { ...context, epoch: 2 })).toThrow('frozen');
});

it('authorizes the exact legacy provider-default binding when the frozen builder has no connection field', () => {
  const { job, context } = fixture('repair');
  delete job.payload.run.comparison.approval.builders[0].connection;
  job.payload.execution.connection = job.payload.execution.provider;
  expect(comparisonSpendMatches(context, job)).toBe(true);
  job.payload.execution.connection = 'another-saved-key';
  expect(comparisonSpendMatches(context, job)).toBe(false);
});

it('keeps provider request JSON from carrying comparison billing or review authority', () => {
  const { job, context } = fixture('builder');
  const result = prepareModelRequest(job, 'claude', '/v1/messages', {
    comparison_approval_id: 'forged', comparison_role: 'reviewer', comparison_review: true,
    comparison_manifest: { digest: 'forged' }, review_only: true,
  }, context);
  for (const key of ['comparison_approval_id', 'comparison_role', 'comparison_review', 'comparison_manifest', 'review_only']) expect(result.body[key]).toBeUndefined();
});
