import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { workspace } from '../../cloudflare/worker/workspace';
import { workspaceSpendConfigure, workspaceSpendStatus } from '../../cloudflare/worker/workspace-spend';
import { bindings, expires, signup } from './reviewer-fixture';

afterEach(reset);
async function fixture(owner: string) {
  await signup(owner);
  await workspace(bindings, owner, { op: 'reviewer_configure', repo_id: 'legacy-repo', expires });
}

it('serializes configuration after a reviewer lock allocated before repository start', async () => {
  const owner = 'race_reviewer'; await fixture(owner);
  const command = { op: 'reviewer_trial', id: 'paused-run' };
  const receipt = await workspace(bindings, owner, command);
  const legacy = await workspace(bindings, owner, { op: 'budget_status' });
  await expect(workspaceSpendConfigure(bindings, owner, 0, 50000000))
    .rejects.toMatchObject({ code: 'WORKSPACE_TRANSITION_BUSY' });
  expect((await workspaceSpendStatus(bindings, owner)).version).toBe(0);
  expect(await workspace(bindings, owner, command)).toEqual(receipt);
  expect(await workspace(bindings, owner, { op: 'budget_status' })).toEqual(legacy);
});

it('serializes later legacy allocations after configuration without changing retained charges', async () => {
  const owner = 'race_configured'; await fixture(owner);
  const allowance = await workspaceSpendConfigure(bindings, owner, 0, 50000000);
  await expect(workspace(bindings, owner, { op: 'reviewer_trial', id: 'late-run' }))
    .rejects.toMatchObject({ code: 'WORKSPACE_LEGACY_INFERENCE_BLOCKED' });
  expect(await workspaceSpendStatus(bindings, owner)).toEqual(allowance);
  expect((await workspace(bindings, owner, { op: 'reviewer_status' })).active_trial).toBeNull();
});
