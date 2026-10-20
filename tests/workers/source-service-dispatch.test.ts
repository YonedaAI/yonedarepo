import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { YonedaEntrypoint } from '../../cloudflare/worker/entrypoint';
import type { SourceIndexEnvelope } from '../../cloudflare/worker/source-contract';
import { hex } from '../../cloudflare/worker/source-crypto';
import { sourceScope } from '../../cloudflare/worker/source-scope';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Envelope, Scope } from '../../cloudflare/worker/types';
import { bindings } from '../../tools/source-benchmark/workerd-source-fixture';
import { modernCompareApproval } from './comparison-review-fixture';
import { readyReviewer } from './reviewer-fixture';
import { workspace } from '../../cloudflare/worker/workspace';
import { syntheticPlatform } from './platform-fixture';

afterEach(reset);

it('defers a cold source launch transactionally, fences its epoch, and launches only once the approved input is complete', async () => {
  const repo = 'source-dispatch-cold';
  const base = { repository: `platform/${repo}`, commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const bytes = new Uint8Array([1, 0, 255]);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header); object.set(bytes, header.length);
  const blob = hex(await crypto.subtle.digest('SHA-1', object));
  const readBlob = vi.fn(async () => new Blob([bytes]));
  const artifact = {
    readCommit: async () => ({ hash: base.commit, treeHash: base.tree }),
    readTree: async () => Array.from({ length: 20 }, (_, index) => ({
      name: `file-${String(index).padStart(2, '0')}.bin`, hash: blob, mode: '100644', type: 'blob',
    })), readBlob,
  };
  const platform = await syntheticPlatform(bindings, { [repo]: artifact }, 'source_owner');
  await ledger(bindings, repo, { op: 'start_run', id: 'dispatch-run', intent: 'Synthetic cold preparation only',
    workspace_transport: 'api-source-v1', _source_transport_approved: true, _source_base: base,
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'Synthetic source dispatch' }] });
  const jobId = 'job:dispatch-run:agent-1';
  const pending: SourceIndexEnvelope[] = [];
  const launched: Scope[] = [];
  const local = { ...platform,
    AGENT_QUEUE: { send: async (value: SourceIndexEnvelope) => { pending.push(value); } },
  } as unknown as Env;
  const service = { env: local, launchExecution: async (_name: string, scope: Scope) => { launched.push(scope); } };
  let acknowledgments = 0;
  let retries = 0;
  const dispatch = async (body: Envelope) => {
    const batch = { messages: [{ body, ack: () => { acknowledgments++; }, retry: () => { retries++; } }] };
    await YonedaEntrypoint.prototype.queue.call(service as YonedaEntrypoint, batch as unknown as MessageBatch<Envelope>);
  };
  const envelope = { v: 1, kind: 'agent', repo_id: repo, job_id: jobId } as Envelope;
  await dispatch(envelope);
  expect(launched).toHaveLength(0);
  const readJob = () => runInDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)),
    (_instance, state) => JSON.parse(String(state.storage.sql.exec('SELECT payload FROM jobs WHERE id=?', jobId).one().payload)));
  const deferred = await readJob();
  expect(deferred).toMatchObject({ status: 'queued', epoch: 2, attempt: 0, model_requests_at_claim: 0,
    source_preparation: { status: 'pending', stage: 'source_preparing' } });
  expect(deferred.model_requests ?? 0).toBe(0);
  const originalDeadline = deferred.dispatch_deadline;
  expect(pending).toHaveLength(1);
  await expect(ledger(bindings, repo, { op: 'check_attempt', job_id: jobId, epoch: 1 })).rejects.toMatchObject({ code: 'FENCED' });
  let batches = 0;
  while (pending.length && batches++ < 8) await dispatch(pending.shift() as SourceIndexEnvelope);
  expect(pending).toHaveLength(0);
  expect(readBlob).toHaveBeenCalledTimes(1);
  expect(launched).toHaveLength(0);
  // The native backoff is real; do not mutate job SQL or fake the authority's clock.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, deferred.not_before - Date.now()) + 25));
  await dispatch(envelope);
  expect(launched).toHaveLength(1);
  expect(launched[0].job.source_mounts).toEqual([expect.objectContaining({ path: 'repo', base, access: 'read_write' })]);
  expect(launched[0].model_calls).toBe(0);
  const current = await readJob();
  expect(current).toMatchObject({ status: 'running', epoch: 3, attempt: 1, model_requests_at_claim: 0,
    dispatch_deadline: originalDeadline });
  expect(current.model_requests ?? 0).toBe(0);
  expect(retries).toBe(0);
  expect(acknowledgments).toBe(2 + batches);
  const bound = await sourceScope(local, launched[0], 'repo');
  expect(bound.binding.epoch).toBe(3);
}, 15000);

it('skips zero-result review and acknowledges stale failed-builder delivery without launch or source indexing', async () => {
  const f = await readyReviewer('source_failed_dispatch');
  await workspace(f.scoped, f.owner, { op: 'workspace_spend_configure', expected_version: 0, limit_microusd: 50000000 });
  await ledger(f.scoped, f.repo, { ...modernCompareApproval(), op: 'start_run', id: 'review-cold',
    intent: 'Explain pre-model builder failures with no source captures', workspace_transport: 'api-source-v1',
    _source_transport_approved: true, _source_base: { repository: `platform/${f.repo}`, commit: f.head, tree: f.tree } });
  for (const index of [1, 2]) {
    const job = await ledger(f.scoped, f.repo, { op: 'claim', job_id: `job:review-cold:agent-${index}` });
    await ledger(f.scoped, f.repo, { op: 'fail', job_id: job.id, epoch: job.epoch, retryable: false,
      error: { code: 'FIXTURE_UNREADABLE_SOURCE', message: 'Synthetic source unavailable before inference' } });
  }
  const detail = await ledger(f.scoped, f.repo, { op: 'run_detail', run_id: 'review-cold' });
  expect(detail.run.comparison).toMatchObject({ status: 'needs_attention', reviewer_status: 'skipped',
    review_skip_reason: { code: 'NO_CHECKED_RESULTS', authority: 'platform' } });
  expect(detail.run.comparison.review_execution_id).toBeFalsy();
  expect(detail.run.status).toBe('failed');
  expect(detail.executions.some((execution: any) => execution.role === 'reviewer')).toBe(false);
  const spending = await workspace(f.scoped, f.owner, { op: 'workspace_spend_status' });
  const jobId = 'job:review-cold:agent-2';
  const get = vi.fn(async (): Promise<Response> => { throw new Error('The failed original source must not be opened by the reviewer'); });
  const send = vi.fn();
  const launches: Scope[] = [];
  const env = { ...f.scoped, PLATFORM: { fetch: get }, AGENT_QUEUE: { send } } as unknown as Env;
  const service = { env, launchExecution: async (_name: string, scope: Scope) => { launches.push(scope); } };
  const ack = vi.fn(); const retry = vi.fn();
  const objectGet = vi.spyOn(f.scoped.OBJECTS, 'get');
  try {
    await YonedaEntrypoint.prototype.queue.call(service as YonedaEntrypoint,
      { messages: [{ body: { v: 1, kind: 'agent', repo_id: f.repo, job_id: jobId }, ack, retry }] } as unknown as MessageBatch<Envelope>);
    expect(launches).toHaveLength(0);
    expect(send).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(objectGet).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
    expect(detail.run.model_requests).toBe(0);
    expect(await workspace(f.scoped, f.owner, { op: 'workspace_spend_status' })).toEqual(spending);
    expect((await ledger(f.scoped, f.repo, { op: 'run_detail', run_id: 'review-cold' })).run).toEqual(detail.run);
  } finally { objectGet.mockRestore(); }
});
