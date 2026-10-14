import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { activateSourceMounts } from '../../cloudflare/worker/source-scope';
import { ledger } from '../../cloudflare/worker/storage';
import { workspace } from '../../cloudflare/worker/workspace';
import type { Scope } from '../../cloudflare/worker/types';
import { modernCompareApproval } from './comparison-review-fixture';
import { readyReviewer } from './reviewer-fixture';

afterEach(reset);

it('terminal failed comparison roots can enter their approved read-only review without inventing two captured candidate mounts', async () => {
  const f = await readyReviewer('source_failed_review');
  await workspace(f.scoped, f.owner, {
    op: 'workspace_spend_configure',
    expected_version: 0,
    limit_microusd: 50000000,
  });
  await ledger(f.scoped, f.repo, {
    ...modernCompareApproval(),
    op: 'start_run',
    id: 'api-compare',
    intent: 'Failure-state source mount fixture; no model requests',
    workspace_transport: 'api-source-v1',
    _source_transport_approved: true,
    _source_base: {
      repository: `yoneda-test/${f.repo}`,
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
    },
  });
  for (const index of [1, 2]) {
    const job = await ledger(f.scoped, f.repo, {
      op: 'claim',
      job_id: `job:api-compare:agent-${index}`,
    });
    await ledger(f.scoped, f.repo, {
      op: 'fail',
      job_id: job.id,
      epoch: job.epoch,
      retryable: false,
      error: { code: 'FIXTURE_FAILURE', message: 'Synthetic pre-model builder failure' },
    });
  }
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
  expect(comparison.manifest.alternatives.every((entry: any) => entry.candidate_id === null)).toBe(
    true,
  );
  const scope: Scope = {
    repo_id: f.repo,
    job,
    supervisor: 'fixture-root',
    model_calls: 0,
    created_at: Date.now(),
  };
  expect(await activateSourceMounts(f.scoped, scope)).toEqual([]);
  expect(detail.run.model_requests).toBe(0);
});
