// Adapter preparation only. Provider execution and overlap are separate live evidence.
import { afterEach, expect, it, vi } from 'vitest';
import type { GuidedSession } from '../../shared/guided-runs';
import { resolveAdaptiveApproval } from '../../cloudflare/worker/adaptive-approval';
import { prepareGuidedRuns } from '../../cloudflare/worker/guided-preparation';
import type { Env, Json } from '../../cloudflare/worker/types';

const { approve } = vi.hoisted(() => ({ approve: vi.fn() }));
vi.mock('../../cloudflare/worker/owner-run-approval', () => ({ approveOwnerRun: approve }));
afterEach(() => vi.clearAllMocks());
const session: GuidedSession = { session_id: 'guide-session:preparation', profile_id: 'task-board-v1',
  version: 1, steps: [], next_step: 'build', working_branch_id: 'guide-working',
  working_revision: { repository: 'local/checked', commit: 'a'.repeat(40) }, working_version: 3 };
const principal = { workspace: 'ordinary', role: 'user' as const };

function normalApproval() {
  approve.mockImplementation(async (_env: Env, _principal: unknown, _repo: string, input: Json) =>
    resolveAdaptiveApproval(input, [{ id: 'saved-glm', provider: 'zai', model: 'glm-5.3-flash' }]));
}

it('build leaves the DAG to the ordinary planner with two parallel specialist preferences and a shared contract', async () => {
  normalApproval();
  const [run] = await prepareGuidedRuns({} as Env, principal, 'fresh', session, 'build', 'a'.repeat(40), 0);
  expect(approve).toHaveBeenCalledTimes(1);
  const input = approve.mock.calls[0][3];
  expect(input.team).toBeUndefined();
  expect(run.adaptive_team.requested_agents).toEqual([
    { connection: null, role: 'backend' }, { connection: null, role: 'frontend' },
  ]);
  expect(run._approved_model_pool).toHaveLength(1);
  expect(run.intent).toContain('addTask(tasks,title,id)');
  expect(run.intent).toContain('independent');
  expect(run.intent).toContain('Do not wait for the core');
  expect(run.intent).toContain('both captured');
  expect(run._workspace_spend).toBe(true);
  expect(run.guided).toBeUndefined(); // Only the transactional ledger stamps phase authority.
});

it('both concurrent approvals retain one checked working lease without prefabricated tasks', async () => {
  normalApproval();
  const runs = await prepareGuidedRuns({} as Env, principal, 'fresh', session, 'concurrent', 'a'.repeat(40), 3);
  expect(runs).toHaveLength(2);
  expect(new Set(runs.map(run => run.id)).size).toBe(2);
  for (const run of runs) {
    expect(run.team).toBeNull();
    expect(run.working_branch_id).toBe('guide-working');
    expect(run.expected_working_commit).toBe('a'.repeat(40));
    expect(run.expected_working_version).toBe(3);
  }
});

it('continuation opens prior context without restating the earlier design choice', async () => {
  normalApproval();
  const [run] = await prepareGuidedRuns({} as Env, principal, 'fresh', session, 'extend', 'a'.repeat(40), 3);
  expect(run.intent).toContain('context_get');
  expect(run.intent).toContain('context_publish');
  expect(run.intent).not.toMatch(/stable|assigned once|replac.*IDs/i);
  expect(run.criteria.join(' ')).not.toMatch(/stable task identity/i);
});

it('fresh continuation with a stale working lease fails before provider approval', async () => {
  await expect(prepareGuidedRuns({} as Env, principal, 'fresh', session, 'extend', 'b'.repeat(40), 3))
    .rejects.toMatchObject({ code: 'HEAD_MOVED' });
  expect(approve).not.toHaveBeenCalled();
});
