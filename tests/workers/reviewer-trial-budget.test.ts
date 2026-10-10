import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import type { Json } from '../../cloudflare/worker/types';
import { ledger } from '../../cloudflare/worker/storage';
import { trialRequest } from '../../cloudflare/worker/reviewer-trial';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, readyReviewer } from './reviewer-fixture';

afterEach(reset);

it('keeps a frozen 24-request approval while new reviewer trials allow 48 Codex requests at unchanged spend caps', async () => {
  const fixture = await readyReviewer('trial_budget_revision');
  const oldId = 'reviewer-previous-approval-123456';
  await workspace(fixture.scoped, fixture.owner, { op: 'reviewer_trial', id: oldId });

  // Recreate the already approved budget from the previous trial revision.
  const previousApproval = trialRequest(oldId);
  previousApproval.model_budgets[0].max_requests = 24;
  await ledger(fixture.scoped, fixture.repo, {
    ...previousApproval,
    op: 'start_run',
    _workspace: fixture.owner,
  });
  const previousBefore = await ledger(fixture.scoped, fixture.repo, {
    op: 'run_detail',
    run_id: oldId,
    _workspace: fixture.owner,
  });
  expect(previousBefore.run.model_budgets).toMatchObject([
    {
      provider: 'codex',
      max_requests: 24,
      max_output_tokens: 4096,
      max_execution_ms: 600000,
      spend_limit_microusd: 200000,
    },
    {
      provider: 'claude',
      max_requests: 24,
      max_output_tokens: 4096,
      max_execution_ms: 600000,
      spend_limit_microusd: 4800000,
    },
  ]);

  await ledger(fixture.scoped, fixture.repo, { op: 'cancel_run', run_id: oldId, _workspace: fixture.owner });
  await api(fixture.scoped, '/api/reviewer', fixture.cookie);
  const response = await api(fixture.scoped, '/api/reviewer/trial', fixture.cookie, {
    request_id: 'new-codex-budget-12345678',
  });
  expect(response.status).toBe(200);
  const { run_id: newId } = await response.json<{ run_id: string }>();
  const newRun = await ledger(fixture.scoped, fixture.repo, {
    op: 'run_detail',
    run_id: newId,
    _workspace: fixture.owner,
  });

  expect(newRun.run.model_budgets).toMatchObject([
    {
      provider: 'codex',
      max_requests: 48,
      max_output_tokens: 4096,
      max_execution_ms: 600000,
      spend_limit_microusd: 200000,
    },
    {
      provider: 'claude',
      max_requests: 24,
      max_output_tokens: 4096,
      max_execution_ms: 600000,
      spend_limit_microusd: 4800000,
    },
  ]);
  const previousAfter = await ledger(fixture.scoped, fixture.repo, {
    op: 'run_detail',
    run_id: oldId,
    _workspace: fixture.owner,
  });
  expect(previousAfter.run.model_budgets).toEqual(previousBefore.run.model_budgets);
  expect((previousAfter.run.model_budgets as Json[])[0].max_requests).toBe(24);
});
