import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { sourceAuthority } from '../../cloudflare/worker/source-authority';
import { sourceIndexBounded } from '../../cloudflare/worker/source-index';
import { prepareSourceDispatch } from '../../cloudflare/worker/source-dispatch';
import { activateSourceMounts, sourceScope } from '../../cloudflare/worker/source-scope';
import { ledger } from '../../cloudflare/worker/storage';
import type { Scope } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { modernCompareApproval } from './comparison-review-fixture';
import { readyReviewer } from './reviewer-fixture';
import { checkedSourceAlternative, reviewSourceEnv } from './source-review-fixture';
import { approvedLedger } from './source-kit';

afterEach(reset);
it('preserves the dense native alias when only the second alternative has a capture and denies reviewer base/uncaptured aliases', async () => {
  const f = await readyReviewer('source_one_capture');
  await workspace(f.scoped, f.owner, { op: 'workspace_spend_configure', expected_version: 0, limit_microusd: 50000000 });
  const base = { repository: `platform/${f.repo}`, commit: f.head, tree: f.tree };
  await approvedLedger(f.scoped, f.repo)({ ...modernCompareApproval(), op: 'start_run', id: 'source-compare',
    intent: 'Synthetic one-capture mount history; no provider requests', workspace_transport: 'api-source-v1',
    _source_transport_approved: true, _source_base: base });
  const candidate = await checkedSourceAlternative(f.scoped, f.repo, 'source-compare', base);
  {
    const root = await ledger(f.scoped, f.repo, { op: 'claim', job_id: 'job:source-compare:agent-1' });
    await ledger(f.scoped, f.repo, { op: 'fail', job_id: root.id, epoch: root.epoch, retryable: false,
      error: { code: 'FIXTURE_FAILURE', message: 'Synthetic terminal builder; no paid model use' } });
  }
  const detail = await ledger(f.scoped, f.repo, { op: 'run_detail', run_id: 'source-compare' });
  const job = await ledger(f.scoped, f.repo, { op: 'claim', job_id: `job:${detail.run.comparison.review_execution_id}` });
  const { revision, tree } = candidate;
  const context = await ledger(f.scoped, f.repo, { op: 'source_read_context', job_id: job.id, epoch: job.epoch });
  expect(context.source_mounts.filter((item: any) => item.path !== 'repo')).toEqual([
    { path: 'candidate-0', base: { ...revision, tree } }]);
  const { env, get, send } = reviewSourceEnv(f.scoped, [candidate], base.commit);
  await sourceIndexBounded(env, { ...revision, tree });
  const scope = { repo_id: f.repo, job, supervisor: 'synthetic-root', model_calls: 0, created_at: Date.now() } as Scope;
  expect(await prepareSourceDispatch(env, scope)).toBe('ready');
  expect(send).not.toHaveBeenCalled();
  const mounts = await activateSourceMounts(env, scope);
  expect(mounts).toEqual([expect.objectContaining({ path: 'candidate-0', base: { ...revision, tree }, access: 'read_only', scratch_paths: [] })]);
  get.mockClear();
  await expect(sourceScope(env, scope, 'repo')).rejects.toMatchObject({ code: 'SOURCE_SCOPE' });
  await expect(sourceScope(env, scope, 'candidate-1')).rejects.toMatchObject({ code: 'SOURCE_SCOPE' });
  expect(get).not.toHaveBeenCalled();
  const side = await sourceScope(env, scope, 'candidate-0');
  await expect(sourceAuthority(env, side.binding.workspace_id, { op: 'source_delete', path: 'app.bin',
    request_id: 'readonly-denial', expected_workspace_version: 0, expected_file_version: 0, _actor: side.actor })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(detail.run.model_requests).toBe(0);
});
