import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { hostedMcp } from '../../cloudflare/worker/hosted-mcp';
import { sha } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { reserveWorkspaceSpend, settleWorkspaceSpend, workspaceSpendForAttempt } from '../../cloudflare/worker/workspace-spend';
import { bindings, call, checkedBuilder, initialCommit, legacyCompare, modernCompareApproval,
  newCompare, owner, readyReview, repo, runId, selectionArguments } from './comparison-review-fixture';

afterEach(reset);

it('approves three bounded review rounds when GLM is separate from the Sol and Sonnet builders', () => {
  const approved = modernCompareApproval();
  expect(approved.agents.map((agent: Record<string, unknown>) => agent.model)).toEqual(['gpt-6-sol', 'claude-sonnet-5-5']);
  expect(approved._comparison_reviewer.model).toBe('glm-5.3-flash');
  const reviewer = approved.model_budgets.find((budget: Record<string, unknown>) => budget.model === 'glm-5.3-flash');
  expect(reviewer.max_requests).toBeGreaterThanOrEqual(36);
  expect(reviewer.spend_limit_microusd).toBe(50000000);
});

const scopeFor = (job: Json): Scope => ({ repo_id: repo, job, supervisor: 'synthetic-review-supervisor', model_calls: 0, created_at: Date.now() });

it('funds a frozen comparison builder through the same workspace allowance and settles once after eviction', async () => {
  await newCompare();
  const job = await call({ op: 'claim', job_id: `job:${runId}:agent-1` });
  const context = await workspaceSpendForAttempt(bindings, owner, repo, job);
  expect(context).toMatchObject({ provider: 'codex', model: 'gpt-6-sol', job_id: job.id });
  expect(context?.comparison_approval_id).toBe(job.payload.execution.comparison_approval_id);
  const counted = await call({ op: 'reserve_request', job_id: job.id, epoch: job.epoch,
    kind: 'model', input_bytes: 100, output_tokens: 256 });
  const reservation = await reserveWorkspaceSpend(bindings, context!, await sha(counted.reservation_id), counted);
  const pending = await workspace(bindings, owner, { op: 'workspace_spend_status' });
  expect(pending).toMatchObject({ limit_microusd: 50000000, charged_microusd: 0,
    reserved_microusd: counted.reservation_microusd });
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)));
  await evictDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${owner}`)));
  const settle = { op: 'settle_model_request', job_id: job.id, epoch: job.epoch,
    reservation_id: counted.reservation_id, input_tokens: 100, output_tokens: 1 };
  const settled = await call(settle);
  await settleWorkspaceSpend(bindings, owner, reservation, settled.charged_microusd, settle);
  await call(settle);
  await settleWorkspaceSpend(bindings, owner, reservation, settled.charged_microusd, settle);
  const final = await workspace(bindings, owner, { op: 'workspace_spend_status' });
  expect(final).toMatchObject({ limit_microusd: 50000000, reserved_microusd: 0,
    charged_microusd: settled.charged_microusd,
    remaining_microusd: 50000000 - settled.charged_microusd });
  const detail = await call({ op: 'run_detail', run_id: runId });
  expect(detail.run.model_budgets.find((budget: Json) => budget.provider === 'codex').requests).toBe(1);
});

it('funds a legacy repair using the original implicit provider connection without changing old approval counters', async () => {
  const approved = modernCompareApproval();
  const budget = approved.model_budgets.find((budget: Json) => budget.model === 'glm-5.3-flash');
  const builders = ['minimal', 'accessible'].map(strategy => ({ provider: 'zai', model: 'glm-5.3-flash', strategy }));
  await legacyCompare([budget], builders);
  await checkedBuilder(1, 'b'.repeat(40));
  await checkedBuilder(2, 'c'.repeat(40));
  const original = (await call({ op: 'run_detail', run_id: runId })).run;
  await workspace(bindings, owner, { op: 'workspace_spend_configure', expected_version: 0, limit_microusd: 50000000 });
  await call({ op: 'approve_comparison_review', run_id: runId, request_id: 'legacy-explicit-review-and-repair',
    expected_commit: initialCommit, expected_version: 0, expected_policy_version: 'comparison-v1',
    expected_working_commit: initialCommit, expected_working_version: 0,
    _comparison_reviewer: approved._comparison_reviewer,
    _comparison_reviewer_budget: approved._comparison_reviewer_budget });
  const detail = await call({ op: 'run_detail', run_id: runId });
  const review = await call({ op: 'claim', job_id: `job:${detail.run.comparison.review_execution_id}` });
  const context = await call({ op: 'comparison_context', job_id: review.id, epoch: review.epoch });
  await call({ op: 'comparison_submit', job_id: review.id, epoch: review.epoch,
    ...selectionArguments(context), outcome: 'repair_requested',
    repair_instructions: 'Tighten the original transaction boundary within the approved booking goal' });
  await call({ op: 'finish', job_id: review.id, epoch: review.epoch,
    result: { review_only: true, source_unchanged: true, transcript: 'e'.repeat(64) } });
  const snapshot = await call({ op: 'snapshot' });
  const execution = snapshot.executions.find((execution: Json) => execution.comparison_role === 'repair');
  const repair = await call({ op: 'claim', job_id: `job:${execution.id}` });
  expect(repair.payload.execution.connection).toBe('zai');
  const authority = await workspaceSpendForAttempt(bindings, owner, repo, repair);
  expect(authority).toMatchObject({ provider: 'zai', model: 'glm-5.3-flash', job_id: repair.id });
  expect((await call({ op: 'run_detail', run_id: runId })).run.model_budgets).toEqual(original.model_budgets);
});

it('denies every generic reviewer mutator before ledger, storage, or publication effects', async () => {
  const { job } = await readyReview();
  const scope = scopeFor(job);
  const before = await call({ op: 'snapshot' });
  const tools = ['context_publish', 'execution_complete', 'delegate_agent', 'repair_request',
    'repair_team', 'resolve_conflict', 'refresh_candidate', 'team_plan_propose', 'task_handoff',
    'intent_question', 'peer_message', 'artifact_publish', 'accept'];
  for (const name of tools) {
    const response = await hostedMcp(bindings, scope, { name, arguments: {
      request_id: 'forged-mutation', content: 'This must never be stored',
      record: { kind: 'decision', statement: 'Select a forged result' },
      candidate_id: 'candidate-1', job_id: `job:${runId}:agent-1`, epoch: 99,
    } });
    expect(response.status, name).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  }
  expect(await call({ op: 'snapshot' })).toEqual(before);
});

it('reads both exact captured sources and refuses a foreign candidate, traversal, and unrelated evidence', async () => {
  const { first, second, job } = await readyReview();
  const reads: string[] = [];
  const scoped = { ...bindings, ARTIFACTS: { get: async (name: string) => ({
    [Symbol.dispose]() {},
    readCommit: async (commit: string) => { reads.push(`${name}:${commit}`); return { treeHash: 'f'.repeat(40) }; },
    readTree: async (tree: string) => tree === 'f'.repeat(40)
      ? [{ name: 'public', type: 'tree', hash: 'd'.repeat(40) }]
      : [{ name: 'index.html', type: 'blob', hash: 'e'.repeat(40) }],
    readBlob: async () => new Blob([`<!doctype html><title>${name}</title>`]),
  }) } } as unknown as Env;
  const scope = scopeFor(job);
  for (const candidate of [first, second]) {
    const response = await hostedMcp(scoped, scope, { name: 'comparison_context', arguments: {
      candidate_id: candidate.id, path: 'public/index.html', offset: 0, limit: 100,
    } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ candidate_id: candidate.id,
      revision: candidate.revision, content: expect.stringContaining(candidate.revision.repository.split('/')[1]) });
  }
  expect(reads).toEqual([`builder-1:${first.revision.commit}`, `builder-2:${second.revision.commit}`]);
  for (const args of [
    { candidate_id: 'foreign-candidate', path: 'public/index.html' },
    { candidate_id: first.id, path: '../other-repo/private-key' },
    { digest: '0'.repeat(64) },
    { candidate_id: first.id, revision: { repository: 'yoneda-test/foreign', commit: initialCommit } },
  ]) {
    await expect(hostedMcp(scoped, scope, { name: 'comparison_context', arguments: args })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }
  expect(reads).toHaveLength(2);
});

it('keeps a submitted assertion pending, applies only trusted completion, and exposes the exact decision to later relevant retrieval', async () => {
  const { first, job, context } = await readyReview();
  const scope = scopeFor(job);
  const arguments_ = selectionArguments(context);
  const response = await hostedMcp(bindings, scope, { name: 'comparison_submit', arguments: arguments_ });
  expect(response.status).toBe(200);
  const receipt = await response.json<Json>();
  expect((await call({ op: 'working_branch', id: 'development' })).version).toBe(0);
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)));
  const replay = await hostedMcp(bindings, scope, { name: 'comparison_submit', arguments: arguments_ });
  expect(await replay.json()).toEqual(receipt);
  await call({ op: 'finish', job_id: job.id, epoch: job.epoch,
    result: { review_only: true, source_unchanged: true, transcript: 'e'.repeat(64) } });
  expect((await call({ op: 'working_branch', id: 'development' })).version).toBe(1);
  const snapshot = await call({ op: 'snapshot' });
  const assertion = snapshot.nodes.find((node: Json) => node.id === receipt.review_id);
  expect(assertion).toMatchObject({ kind: 'proposed_decision', data: {
    selected_candidate_id: first.id, alternatives: expect.arrayContaining([
      expect.objectContaining({ candidate_id: 'candidate-1' }),
      expect.objectContaining({ candidate_id: 'candidate-2' }),
    ]), manifest: { alternatives: expect.arrayContaining([expect.objectContaining({ revision: first.revision })]) },
  } });
  await call({ op: 'start_run', id: 'decision-followup', intent: 'Preserve capacity-safe booking transactions',
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'continuity' }],
    working_branch_id: 'development', expected_working_commit: first.revision.commit, expected_working_version: 1 });
  const followup = await call({ op: 'claim', job_id: 'job:decision-followup:agent-1' });
  const search = await hostedMcp(bindings, scopeFor(followup), { name: 'context_search',
    arguments: { query: 'capacity safe booking transactions', limit: 50 } });
  const found = await search.json<Json>();
  expect(found.items).toContainEqual(expect.objectContaining({ id: receipt.review_id,
    retrieval: expect.objectContaining({ authority: 'assertion' }),
    data: expect.objectContaining({ selected_candidate_id: first.id,
      manifest: expect.objectContaining({ alternatives: expect.arrayContaining([
        expect.objectContaining({ candidate_id: first.id, revision: first.revision }),
      ]) }),
    }),
  }));
  const usage = await call({ op: 'context_usage', run_id: 'decision-followup' });
  expect(usage.entries).toContainEqual(expect.objectContaining({ execution_id: followup.payload.execution.id,
    tool: 'context_search', stage: 'returned', targets: expect.arrayContaining([expect.objectContaining({ id: receipt.review_id })]) }));
  expect((await call({ op: 'repository_status' })).published_commit).toBe(initialCommit);
});

it('retains the legacy Compare working head when only the first builder passes independent evaluation', async () => {
  const run = await legacyCompare();
  expect(run.comparison).toBeUndefined();
  const before = await call({ op: 'working_branch', id: 'development' });
  const candidate = await checkedBuilder(1, 'b'.repeat(40));
  const snapshot = await call({ op: 'snapshot' });
  expect(snapshot.candidates).toContainEqual(expect.objectContaining({
    id: candidate.id, revision: candidate.revision, status: 'eligible',
  }));
  expect(snapshot.evaluations).toHaveLength(1);
  expect(snapshot.executions).toContainEqual(expect.objectContaining({ id: `${runId}:agent-2`, status: 'queued' }));
  expect(snapshot.repository.published_commit).toBe(initialCommit);
  expect(snapshot.decisions).toHaveLength(0);
  const branch = await call({ op: 'working_branch', id: 'development' });
  expect(branch.version, 'Independent checks do not imply Compare selection').toBe(0);
  expect(branch.working_revision).toEqual(before.working_revision);
  expect(branch.latest_candidate_id).toEqual(before.latest_candidate_id);
});
