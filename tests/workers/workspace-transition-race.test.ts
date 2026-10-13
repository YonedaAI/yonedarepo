import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { campaignModelBudgets } from '../../cloudflare/worker/reviewer-campaign';
import type { Json } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { workspaceSpendConfigure, workspaceSpendStatus } from '../../cloudflare/worker/workspace-spend';
import { bindings, expires, signup } from './reviewer-fixture';

afterEach(reset);
async function fixture(owner: string) {
  await signup(owner);
  await workspace(bindings, owner, { op: 'reviewer_configure', repo_id: 'legacy-repo', expires });
  await workspace(bindings, owner, { op: 'campaign_configure', id: 'retained', expected_version: 0,
    approval: { version: 1, audience: 'owner', repo_ids: ['legacy-repo'], expires,
      limit_microusd: 50000000, chain_limit_microusd: 5000000,
      buckets: { routine: 35000000, opus: 10000000, reserve: 5000000 }, model_budgets: [campaignModelBudgets[1]] } });
  await workspace(bindings, owner, { op: 'campaign_enable', id: 'retained', expected_version: 1,
    expected_revision: 1, local_gate_receipt: 'Synthetic local gate' });
}
function trial(): Json {
  return { op: 'campaign_trial', id: 'retained', run_id: 'paused-run', repo_id: 'legacy-repo',
    run_request: { id: 'paused-run', campaign: { id: 'retained', version: 1 },
      working_branch_id: 'campaign-development', mode: 'collaborate', autonomy_policy: { enabled: true } } };
}

it.each(['reviewer', 'campaign'])('serializes configuration after a %s lock allocated before repository start', async (kind) => {
  const owner = `race_${kind}`; await fixture(owner);
  const command = kind === 'reviewer' ? { op: 'reviewer_trial', id: 'paused-run' } : trial();
  const receipt = await workspace(bindings, owner, command);
  const legacy = await workspace(bindings, owner, { op: 'budget_status' });
  const campaign = await workspace(bindings, owner, { op: 'campaign_status', id: 'retained' });
  await expect(workspaceSpendConfigure(bindings, owner, 0, 50000000))
    .rejects.toMatchObject({ code: 'WORKSPACE_TRANSITION_BUSY' });
  expect((await workspaceSpendStatus(bindings, owner)).version).toBe(0);
  expect(await workspace(bindings, owner, command)).toEqual(receipt);
  expect(await workspace(bindings, owner, { op: 'campaign_status', id: 'retained' })).toEqual(campaign);
  expect(await workspace(bindings, owner, { op: 'budget_status' })).toEqual(legacy);
});

it('serializes later legacy allocations after configuration without changing retained approvals or charges', async () => {
  const owner = 'race_configured'; await fixture(owner);
  const before = await workspace(bindings, owner, { op: 'campaign_status', id: 'retained' });
  const allowance = await workspaceSpendConfigure(bindings, owner, 0, 50000000);
  for (const command of [{ op: 'reviewer_trial', id: 'late-run' }, trial()])
    await expect(workspace(bindings, owner, command)).rejects.toMatchObject({ code: 'WORKSPACE_LEGACY_INFERENCE_BLOCKED' });
  expect(await workspaceSpendStatus(bindings, owner)).toEqual(allowance);
  expect(await workspace(bindings, owner, { op: 'campaign_status', id: 'retained' })).toEqual(before);
  expect((await workspace(bindings, owner, { op: 'reviewer_status' })).active_trial).toBeNull();
  await expect(workspace(bindings, owner, { op: 'campaign_trial_status', id: 'retained', run_id: 'paused-run' }))
    .rejects.toMatchObject({ code: 'NOT_FOUND' });
});
