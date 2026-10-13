import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { hostedMcp } from '../../cloudflare/worker/hosted-mcp';
import { modelHandler } from '../../cloudflare/worker/models';
import { object, sha } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { reserveWorkspaceSpend, settleWorkspaceSpend, workspaceSpendForAttempt } from '../../cloudflare/worker/workspace-spend';
import { bindings, call, checkedBuilder, initialCommit, newCompare, owner, repo, runId } from './comparison-review-fixture';

afterEach(reset);

it('keeps both new builders authorized through 33 settled requests, completion hints, capture and clean evaluation', async () => {
  await newCompare();
  const jobs = await Promise.all([1, 2].map(index => call({ op: 'claim', job_id: `job:${runId}:agent-${index}` })));
  for (const [index, job] of jobs.entries()) {
    const frozen = structuredClone(job.payload.run.comparison.approval);
    expect(job.payload.run.model_budgets.every((budget: Json) => budget.requests === 0)).toBe(true);
    for (let request = 0; request < (index === 0 ? 17 : 16); request++) {
      const authority = await workspaceSpendForAttempt(bindings, owner, repo, job);
      const reserved = await call({ op: 'reserve_request', job_id: job.id, epoch: job.epoch,
        kind: 'model', input_bytes: 100, output_tokens: 256 });
      const reservation = await reserveWorkspaceSpend(bindings, authority!, await sha(reserved.reservation_id), reserved);
      const settlement = { op: 'settle_model_request', job_id: job.id, epoch: job.epoch,
        reservation_id: reserved.reservation_id, input_tokens: 100, output_tokens: 1 };
      const settled = await call(settlement);
      await settleWorkspaceSpend(bindings, owner, reservation, settled.charged_microusd, settlement);
    }
    const current = await call({ op: 'run_detail', run_id: runId });
    expect(current.run.comparison.approval).toEqual(frozen);
    const authority = await workspaceSpendForAttempt(bindings, owner, repo, job);
    expect(authority?.model_budget.requests).toBe(index === 0 ? 17 : 16);
    const scope: Scope = { repo_id: repo, job, supervisor: 'synthetic-phase-supervisor', model_calls: 0, created_at: Date.now() };
    const hint = await hostedMcp(bindings, scope, { name: 'execution_complete', arguments: { summary: 'Synthetic source ready for capture' } });
    expect(hint.status).toBe(200);
    expect(await hint.json()).toMatchObject({ authoritative: false, status: 'capture_requested' });
    await checkedBuilder(index + 1, (index === 0 ? 'b' : 'c').repeat(40), job);
  }
  const detail = await call({ op: 'run_detail', run_id: runId });
  expect(detail.run.model_requests).toBe(33);
  expect(detail.run.model_budgets.reduce((total: number, budget: Json) => total + budget.requests, 0)).toBe(33);
  expect(detail.candidates).toHaveLength(2);
  expect(detail.candidates.every((candidate: Json) => candidate.status === 'eligible')).toBe(true);
  expect(detail.evaluations).toHaveLength(2);
  expect(detail.run.comparison.status).toBe('reviewing');
  const wallet = await workspace(bindings, owner, { op: 'workspace_spend_status' });
  expect(wallet.limit_microusd).toBe(50000000);
  expect(wallet.reserved_microusd).toBe(0);
  expect(wallet.charged_microusd).toBeGreaterThan(0);
  expect((await call({ op: 'repository_status' })).published_commit).toBe(initialCommit);
});

it('denies every model transport for an actual comparison capture attempt without reserving funds', async () => {
  await newCompare();
  const builder = await call({ op: 'claim', job_id: `job:${runId}:agent-1` });
  const source = await object(bindings, JSON.stringify({ files: { 'app.js': { content: 'export const captured = true;' } } }));
  await call({ op: 'finish', job_id: builder.id, epoch: builder.epoch, result: { workspace: source.digest } });
  const capture = await call({ op: 'claim', job_id: `capture:${runId}:agent-1` });
  expect(capture.payload.run).toBeUndefined();
  expect(capture.payload.execution.comparison_approval_id).toBe(builder.payload.execution.comparison_approval_id);
  const scope: Scope = { repo_id: repo, job: capture, supervisor: 'synthetic-capture-supervisor', model_calls: 0, created_at: Date.now() };
  // Only the container RPC binding is substituted; check_attempt, ledger and wallet are real DOs.
  const scoped = { ...bindings, EXECUTIONS: {
    idFromString: (id: string) => id, get: () => ({ scope: async () => scope }),
  } } as unknown as Env;
  const snapshot = await call({ op: 'snapshot' });
  const wallet = await workspace(bindings, owner, { op: 'workspace_spend_status' });
  const upstream = vi.fn(() => { throw new Error('A capture must never contact inference'); });
  vi.stubGlobal('fetch', upstream);
  try {
    for (const provider of ['codex', 'claude', 'gemini'] as const) {
      const result = await modelHandler(provider)(new Request(`http://${provider}.yoneda.internal/v1/messages`, {
        method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Synthetic denied probe' }] }),
      }), scoped, { containerId: 'synthetic-capture-container' } as Parameters<ReturnType<typeof modelHandler>>[2]);
      expect(result.status).toBe(403);
      expect(await result.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(await call({ op: 'snapshot' })).toEqual(snapshot);
    expect(await workspace(bindings, owner, { op: 'workspace_spend_status' })).toEqual(wallet);
  } finally { vi.unstubAllGlobals(); }
});
