import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { YonedaEntrypoint } from '../../cloudflare/worker/entrypoint';
import type { SourceIndexEnvelope, SourceReadContext } from '../../cloudflare/worker/source-contract';
import { hex } from '../../cloudflare/worker/source-crypto';
import { preparedSourceView } from '../../cloudflare/worker/source-index';
import { sourceIndexEnvelope } from '../../cloudflare/worker/source-index-queue';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { bindings } from '../../tools/source-benchmark/workerd-source-fixture';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';

afterEach(reset);

it('continues legitimate cold preparation beyond four queue batches without burning transport retries or claiming a model job', async () => {
  const repo = 'source-queue-many-files';
  const revision = { repository: `yoneda-test/${repo}`, commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const bytes = new Uint8Array([0, 255]);
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const input = new Uint8Array(prefix.length + bytes.length); input.set(prefix); input.set(bytes, prefix.length);
  const blob = hex(await crypto.subtle.digest('SHA-1', input));
  const readBlob = vi.fn(async () => new Blob([bytes]));
  const artifact = { readCommit: async () => ({ hash: revision.commit, treeHash: revision.tree }),
    readTree: async () => Array.from({ length: 100 }, (_, index) => ({ name: `f-${String(index).padStart(3, '0')}.bin`,
      hash: blob, mode: '100644', type: 'blob' })), readBlob, [Symbol.dispose]() {} } as unknown as ArtifactsRepo;
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Bounded queue index', workspace: 'source_owner',
    remote: { namespace: 'yoneda-test', name: repo }, commit: revision.commit, policy: reviewerPolicy });
  await ledger(bindings, repo, { op: 'start_run', id: 'index-run', intent: 'Prepare immutable source before models',
    workspace_transport: 'api-source-v1', _source_transport_approved: true, _source_base: revision,
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'Synthetic source index' }] });
  const context = await ledger(bindings, repo, { op: 'source_read_context', job_id: 'job:index-run:agent-1' }) as SourceReadContext;
  const messages = [sourceIndexEnvelope(context, revision)];
  let acked = 0;
  let retried = 0;
  let batches = 0;
  const send = vi.fn(async (envelope: SourceIndexEnvelope, options: { delaySeconds?: number }) => {
    expect(options).toEqual({ delaySeconds: 1 });
    messages.push(envelope);
  });
  const local = { ...bindings, AGENT_QUEUE: { send }, ARTIFACTS: { get: async () => artifact } } as unknown as Env;
  while (messages.length && batches < 12) {
    const body = messages.shift();
    batches++;
    const batch = { messages: [{ body, ack: () => { acked++; }, retry: () => { retried++; } }] } as unknown as MessageBatch<Envelope>;
    await YonedaEntrypoint.prototype.queue.call({ env: local } as YonedaEntrypoint, batch);
  }
  expect(retried).toBe(0);
  expect(batches).toBeGreaterThan(4);
  expect(acked).toBe(batches);
  expect((await preparedSourceView(local, revision)).files).toHaveLength(100);
  expect(readBlob).toHaveBeenCalledTimes(1);
  const job = await ledger(bindings, repo, { op: 'job_status', id: context.job_id });
  expect(job.status).toBe('queued');
  expect(job.epoch).toBe(0);
  expect(job.attempt).toBe(0);
});
