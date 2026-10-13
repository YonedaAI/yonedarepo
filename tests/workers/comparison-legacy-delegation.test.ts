import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import type { Json } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import {
  agents, bindings, call, checkedBuilder, initialCommit, modernCompareApproval,
  owner, policy, repo, runId,
} from './comparison-review-fixture';

afterEach(reset);

/** Historical ordinary approvals froze enabled=true even when the two roots exhausted the cap. */
async function terminalLegacy(maxExecutions: number) {
  await workspace(bindings, owner, { op: 'signup', username: owner,
    password: 'Synthetic legacy delegation password', salt: '01'.repeat(16),
    recovery_hash: 'b'.repeat(64), session_hash: 'a'.repeat(64) });
  await call({ op: 'init', id: repo, name: 'Historical fixed-root comparison',
    workspace: owner, remote: { namespace: 'yoneda-test', name: repo }, commit: initialCommit, policy });
  await call({ op: 'create_working_branch', id: 'development',
    expected_commit: initialCommit, expected_version: 0 });
  const approved = modernCompareApproval();
  const budget = approved.model_budgets.find((value: Json) => value.model === 'glm-5.3-flash');
  await call({ op: 'start_run', id: runId, mode: 'compare',
    intent: 'Compare two independently checked booking implementations', agents,
    model_budgets: [budget], working_branch_id: 'development',
    expected_working_commit: initialCommit, expected_working_version: 0,
    delegation: { enabled: true, max_depth: 1, max_executions: maxExecutions } });
  const first = await call({ op: 'claim', job_id: `job:${runId}:agent-1` });
  const reservation = await call({ op: 'reserve_request', job_id: first.id, epoch: first.epoch,
    kind: 'model', input_bytes: 100, output_tokens: 256 });
  await call({ op: 'settle_model_request', job_id: first.id, epoch: first.epoch,
    reservation_id: reservation.reservation_id, input_tokens: 100, output_tokens: 1 });
  await checkedBuilder(1, 'b'.repeat(40), first);
  await checkedBuilder(2, 'c'.repeat(40));
  await workspace(bindings, owner, { op: 'workspace_spend_configure',
    expected_version: 0, limit_microusd: 50000000 });
  return { approved, before: await call({ op: 'run_detail', run_id: runId }) };
}

function approval(approved: Json) {
  return { op: 'approve_comparison_review', run_id: runId, request_id: 'historical-fixed-roots',
    expected_commit: initialCommit, expected_version: 0, expected_policy_version: policy.version,
    expected_working_commit: initialCommit, expected_working_version: 0,
    _comparison_reviewer: approved._comparison_reviewer,
    _comparison_reviewer_budget: approved._comparison_reviewer_budget };
}

it('additively approves the historical enabled flag when its two execution slots are exactly the original roots', async () => {
  const { approved, before } = await terminalLegacy(2);
  expect(before.run.delegation).toEqual({ enabled: true, max_depth: 1, max_executions: 2 });
  expect(before.run.model_requests).toBe(1);
  expect(before.run.model_budgets[0].charged_microusd).toBeGreaterThan(0);
  expect(before.executions).toHaveLength(2);
  expect(before.executions.map((execution: Json) => execution.id).sort())
    .toEqual([`${runId}:agent-1`, `${runId}:agent-2`]);
  expect(before.executions.every((execution: Json) => execution.depth === 0
    && !execution.parent_execution && !execution.parent_execution_id)).toBe(true);
  const command = approval(approved);
  const receipt = await call(command);
  expect(receipt.comparison.approval).toMatchObject({ budget_scope: 'comparison_approval',
    max_review_requests: 12, max_repair_rounds: 2 });
  expect(await call(command)).toEqual(receipt);
  const after = await call({ op: 'run_detail', run_id: runId });
  expect(after.run.model_budgets).toEqual(before.run.model_budgets);
  expect(after.run.model_requests).toBe(before.run.model_requests);
  expect(after.run.delegation).toEqual(before.run.delegation);
  expect(after.run.policy).toEqual(before.run.policy);
  expect(after.run.comparison.model_budgets.every((budget: Json) => budget.requests === 0 && budget.charged_microusd === 0)).toBe(true);
  expect(after.executions.filter((execution: Json) => execution.comparison_role === 'reviewer')).toHaveLength(1);
  expect((await call({ op: 'repository_status' })).published_commit).toBe(initialCommit);
});

it('still denies legacy delegation with room for another execution and leaves the snapshot unchanged', async () => {
  const { approved } = await terminalLegacy(3);
  const before = await call({ op: 'snapshot' });
  await expect(call(approval(approved))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  expect(await call({ op: 'snapshot' })).toEqual(before);
});
