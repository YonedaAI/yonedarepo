import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { activateSourceMounts } from '../../cloudflare/worker/source-scope';
import { sourceScope } from '../../cloudflare/worker/source-scope';
import { sourceAuthority } from '../../cloudflare/worker/source-authority';
import { prepareSourceDispatch } from '../../cloudflare/worker/source-dispatch';
import { sourceIndexBounded } from '../../cloudflare/worker/source-index';
import { ledger } from '../../cloudflare/worker/storage';
import { workspace } from '../../cloudflare/worker/workspace';
import type { Scope } from '../../cloudflare/worker/types';
import { modernCompareApproval } from './comparison-review-fixture';
import { readyReviewer } from './reviewer-fixture';
import { checkedSourceAlternative, reviewSourceEnv } from './source-review-fixture';
import { approvedLedger } from './source-kit';

afterEach(reset);

it('independently checked alternatives enter read-only review with exactly their captured mounts and no base authority', async () => {
  const f = await readyReviewer('source_failed_review');
  await workspace(f.scoped, f.owner, {
    op: 'workspace_spend_configure',
    expected_version: 0,
    limit_microusd: 50000000,
  });
  const base = { repository: `platform/${f.repo}`, commit: f.head, tree: f.tree };
  await approvedLedger(f.scoped, f.repo)({
    ...modernCompareApproval(),
    op: 'start_run',
    id: 'api-compare',
    intent: 'Read-only checked source mount fixture; no model requests',
    workspace_transport: 'api-source-v1',
    _source_transport_approved: true,
    _source_base: base,
  });
  const first = await checkedSourceAlternative(f.scoped, f.repo, 'api-compare', base, 1);
  const second = await checkedSourceAlternative(f.scoped, f.repo, 'api-compare', base, 2);
  const detail = await ledger(f.scoped, f.repo, { op: 'run_detail', run_id: 'api-compare' });
  expect(detail.run.comparison.status).toBe('reviewing');
  const job = await ledger(f.scoped, f.repo, {
    op: 'claim',
    job_id: `job:${detail.run.comparison.review_execution_id}`,
  });
  const comparison = await ledger(f.scoped, f.repo, {
    op: 'comparison_context',
    job_id: job.id,
    epoch: job.epoch,
  });
  expect(comparison.manifest.alternatives).toHaveLength(2);
  expect(comparison.manifest.alternatives.map((entry: any) => entry.candidate_id)).toEqual([first.id, second.id]);
  expect(comparison.manifest.candidates.every((candidate: any) => candidate.status === 'eligible' && candidate.evaluation)).toBe(true);
  const scope: Scope = {
    repo_id: f.repo,
    job,
    supervisor: 'fixture-root',
    model_calls: 0,
    created_at: Date.now(),
  };
  const { env, get, send } = reviewSourceEnv(f.scoped, [first, second], base.commit);
  for (const candidate of [first, second])
    await sourceIndexBounded(env, { ...candidate.revision, tree: candidate.tree });
  expect(await prepareSourceDispatch(env, scope)).toBe('ready');
  expect(send).not.toHaveBeenCalled();
  expect(await activateSourceMounts(env, scope)).toEqual([
    expect.objectContaining({ path: 'candidate-0', access: 'read_only', scratch_paths: [], base: { ...first.revision, tree: first.tree } }),
    expect.objectContaining({ path: 'candidate-1', access: 'read_only', scratch_paths: [], base: { ...second.revision, tree: second.tree } }),
  ]);
  get.mockClear();
  await expect(sourceScope(env, scope, 'repo')).rejects.toMatchObject({ code: 'SOURCE_SCOPE' });
  expect(get).not.toHaveBeenCalled();
  for (const alias of ['candidate-0', 'candidate-1']) {
    const side = await sourceScope(env, scope, alias);
    await expect(sourceAuthority(env, side.binding.workspace_id, { op: 'source_upload_ticket', request_id: 'review-write-denied',
      path: 'app.bin', sha256: 'a'.repeat(64), size: 1, mode: '100644', expected_workspace_version: 0,
      expected_file_version: 0, _actor: side.actor })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }
  expect(detail.run.model_requests).toBe(0);
});
