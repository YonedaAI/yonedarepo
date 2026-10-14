import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { sourceAuthority } from '../../cloudflare/worker/source-authority';
import { hex, sourceFingerprint } from '../../cloudflare/worker/source-crypto';
import { sourceIndexBounded } from '../../cloudflare/worker/source-index';
import { prepareSourceDispatch } from '../../cloudflare/worker/source-dispatch';
import { activateSourceMounts, sourceScope } from '../../cloudflare/worker/source-scope';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Scope } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { modernCompareApproval } from './comparison-review-fixture';
import { readyReviewer } from './reviewer-fixture';

afterEach(reset);
it('preserves the dense native alias when only the second alternative has a capture and denies reviewer base/uncaptured aliases', async () => {
  const f = await readyReviewer('source_one_capture');
  await workspace(f.scoped, f.owner, { op: 'workspace_spend_configure', expected_version: 0, limit_microusd: 50000000 });
  await ledger(f.scoped, f.repo, { ...modernCompareApproval(), op: 'start_run', id: 'source-compare',
    intent: 'Synthetic one-capture mount history; no provider requests', workspace_transport: 'api-source-v1',
    _source_transport_approved: true, _source_base: { repository: `yoneda-test/${f.repo}`, commit: 'a'.repeat(40), tree: 'b'.repeat(40) } });
  for (const index of [1, 2]) {
    const root = await ledger(f.scoped, f.repo, { op: 'claim', job_id: `job:source-compare:agent-${index}` });
    await ledger(f.scoped, f.repo, { op: 'fail', job_id: root.id, epoch: root.epoch, retryable: false,
      error: { code: 'FIXTURE_FAILURE', message: 'Synthetic terminal builder; no paid model use' } });
  }
  const detail = await ledger(f.scoped, f.repo, { op: 'run_detail', run_id: 'source-compare' });
  const job = await ledger(f.scoped, f.repo, { op: 'claim', job_id: `job:${detail.run.comparison.review_execution_id}` });
  const revision = { repository: 'yoneda-test/only-second-capture', commit: 'c'.repeat(40) };
  const stub = f.scoped.REPOSITORIES.get(f.scoped.REPOSITORIES.idFromName(f.repo));
  // Synthetic retained capture in a frozen review manifest; exercise actual native scope, not inference.
  await runInDurableObject(stub, async (_instance, state) => {
    const native = JSON.parse(String(state.storage.sql.exec('SELECT payload FROM jobs WHERE id=?', job.id).one().payload));
    const manifest = native.payload.comparison_manifest.manifest;
    manifest.alternatives[1].candidate_id = 'only-capture';
    manifest.alternatives[1].revision = revision;
    native.payload.comparison_manifest.manifest_digest = await sourceFingerprint(manifest);
    state.storage.sql.exec('UPDATE jobs SET payload=? WHERE id=?', JSON.stringify(native), job.id);
    state.storage.sql.exec('INSERT INTO candidates(id,payload) VALUES(?,?)', 'only-capture', JSON.stringify({
      id: 'only-capture', run_id: 'source-compare', revision, tree: 'd'.repeat(40), status: 'eligible' }));
  });
  const context = await ledger(f.scoped, f.repo, { op: 'source_read_context', job_id: job.id, epoch: job.epoch });
  expect(context.source_mounts.filter((item: any) => item.path !== 'repo')).toEqual([
    { path: 'candidate-0', base: { ...revision, tree: 'd'.repeat(40) } }]);
  const bytes = new Uint8Array([0, 255]);
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const body = new Uint8Array(prefix.length + bytes.length); body.set(prefix); body.set(bytes, prefix.length);
  const blob = hex(await crypto.subtle.digest('SHA-1', body));
  const get = vi.fn(async (name: string) => {
    expect(name).toBe('only-second-capture');
    return { readCommit: async () => ({ hash: revision.commit, treeHash: 'd'.repeat(40) }),
      readTree: async () => [{ name: 'app.bin', type: 'blob', mode: '100644', hash: blob }],
      readBlob: async () => new Blob([bytes]), [Symbol.dispose]() {} } as unknown as ArtifactsRepo;
  });
  const send = vi.fn();
  const env = { ...f.scoped, ARTIFACTS: { get }, AGENT_QUEUE: { send } } as unknown as Env;
  await sourceIndexBounded(env, context.source_mounts[1].base);
  const scope = { repo_id: f.repo, job, supervisor: 'synthetic-root', model_calls: 0, created_at: Date.now() } as Scope;
  expect(await prepareSourceDispatch(env, scope)).toBe('ready');
  expect(send).not.toHaveBeenCalled();
  const mounts = await activateSourceMounts(env, scope);
  expect(mounts).toEqual([expect.objectContaining({ path: 'candidate-0', base: { ...revision, tree: 'd'.repeat(40) }, access: 'read_only', scratch_paths: [] })]);
  get.mockClear();
  await expect(sourceScope(env, scope, 'repo')).rejects.toMatchObject({ code: 'SOURCE_SCOPE' });
  await expect(sourceScope(env, scope, 'candidate-1')).rejects.toMatchObject({ code: 'SOURCE_SCOPE' });
  expect(get).not.toHaveBeenCalled();
  const side = await sourceScope(env, scope, 'candidate-0');
  await expect(sourceAuthority(env, side.binding.workspace_id, { op: 'source_delete', path: 'app.bin',
    request_id: 'readonly-denial', expected_workspace_version: 0, expected_file_version: 0, _actor: side.actor })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(detail.run.model_requests).toBe(0);
});
