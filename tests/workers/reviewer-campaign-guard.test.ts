import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { reviewerGuard } from '../../cloudflare/worker/reviewer';
import { campaignModelBudgets, reviewerCampaignId } from '../../cloudflare/worker/reviewer-campaign-policy';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, bindings, expires, readyReviewer } from './reviewer-fixture';

afterEach(reset);

it('gates legacy campaign endpoints internally while generic owner commands remain available', async () => {
  const f = await readyReviewer('campaign_guard');
  const repo = 'fresh-enabled-booking';
  const principal = { role: 'user' as const, workspace: f.owner, reviewer: true };
  const guard = (action: string, target = repo) => reviewerGuard(new Request(`https://yoneda/api/repos/${target}/${action}`, { method: 'POST' }), f.scoped, principal);
  await workspace(bindings, f.owner, {
    op: 'campaign_configure', id: reviewerCampaignId, expected_version: 0,
    approval: { version: 1, profile: 'reviewer-event-booking-v1', audience: 'owner', repo_ids: [repo], expires,
      limit_microusd: 50000000, chain_limit_microusd: 5000000,
      buckets: { routine: 35000000, opus: 10000000, reserve: 5000000 }, model_budgets: campaignModelBudgets,
      entry: { repo_id: repo, working_branch_id: 'campaign-development' } },
  });
  expect(await guard('accept')).toBeNull();
  const legacyTrial = () => api(f.scoped, '/api/reviewer/campaign/trial', f.cookie, { request_id: 'legacy-campaign-request-1234', repo_id: 'ordinary-repository', adaptive_team: { version: 1 } });
  expect((await legacyTrial()).status).toBe(409);
  await workspace(bindings, f.owner, { op: 'reviewer_campaign_enable', id: reviewerCampaignId,
    expected_version: 1, expected_revision: 1, local_gate_receipt: 'controlled fixture gate', glm_evidence_run_id: 'controlled-checked-run' });
  for (const action of ['accept', 'cancel_run', 'resync_repository', 'answer_intent']) expect(await guard(action)).toBeNull();
  for (const action of ['start_run', 'resolve_conflict', 'repair_team', 'refresh_candidate', 'update_policy']) expect(await guard(action)).toBeNull();
  expect(await guard('accept', 'ordinary-repository')).toBeNull();
  await workspace(bindings, f.owner, { op: 'campaign_disable', id: reviewerCampaignId, expected_version: 1, expected_revision: 2 });
  expect(await guard('accept')).toBeNull();
  expect((await legacyTrial()).status).toBe(409);
});
