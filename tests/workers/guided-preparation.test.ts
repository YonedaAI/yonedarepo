// Adapter preparation only. Provider execution and overlap are separate live evidence.
import { afterEach, expect, it, vi } from 'vitest';
import { type GuidedSession, guidedIntents } from '../../shared/guided-runs';
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
    resolveAdaptiveApproval(input, connections));
}
const connections = [
  { id: 'saved-glm', provider: 'zai', model: 'glm-5.3-flash' },
  { id: 'saved-codex', provider: 'codex', model: 'gpt-5.6-luna' },
];
const v2 = { ...session, version: 2 } as unknown as GuidedSession;
const slots = (run: Json) => run.agents.map((agent: Json) => agent.connection);

it('build leaves the DAG to the ordinary planner with two parallel specialist preferences and a shared contract', async () => {
  normalApproval();
  const [run] = await prepareGuidedRuns({} as Env, principal, 'fresh', session, 'build', 'a'.repeat(40), 0);
  expect(approve).toHaveBeenCalledTimes(1);
  const input = approve.mock.calls[0][3];
  expect(input.team).toBeUndefined();
  expect(run.adaptive_team.requested_agents).toEqual([
    { connection: null, role: 'backend', reasoning_effort: 'low' },
    { connection: null, role: 'frontend', reasoning_effort: 'low' },
  ]);
  expect(run._approved_model_pool).toHaveLength(2);
  expect(run.agents[0].connection).toBe('saved-glm'); // v1 still plans on the coordination model.
  expect(run.adaptive_team.specialist_connection).toBe('saved-codex');
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

it('version 1 sessions keep their original briefs and planner wording', async () => {
  normalApproval();
  const [build] = await prepareGuidedRuns({} as Env, principal, 'fresh', session, 'build', 'a'.repeat(40), 0);
  expect(build.intent.startsWith(`${guidedIntents(1).build} Publish the stable-identity`)).toBe(true);
  expect(build.intent).toContain('Plan two independent specialist scopes');
});

it('version 2 sessions use the version 2 briefs at every step', async () => {
  normalApproval();
  const [build] = await prepareGuidedRuns({} as Env, principal, 'fresh', v2, 'build', 'a'.repeat(40), 0);
  expect(build.intent.startsWith(`${guidedIntents(2).build} Publish the stable-identity`)).toBe(true);
  const [extend] = await prepareGuidedRuns({} as Env, principal, 'fresh', v2, 'extend', 'a'.repeat(40), 3);
  expect(extend.intent.startsWith(guidedIntents(2).extend)).toBe(true);
  expect(extend.intent).not.toMatch(/stable|assigned once|replac.*IDs/i);
  const runs = await prepareGuidedRuns({} as Env, principal, 'fresh', v2, 'concurrent', 'a'.repeat(40), 3);
  expect(runs.map((run, index) => run.intent.startsWith(guidedIntents(2).concurrent[index])))
    .toEqual([true, true]);
});

it('an unknown session version fails before provider approval', async () => {
  const forged = { ...session, version: 3 } as unknown as GuidedSession;
  await expect(prepareGuidedRuns({} as Env, principal, 'fresh', forged, 'build', 'a'.repeat(40), 0))
    .rejects.toMatchObject({ code: 'GUIDED_VERSION_MISMATCH' });
  expect(approve).not.toHaveBeenCalled();
});

it('fresh continuation with a stale working lease fails before provider approval', async () => {
  await expect(prepareGuidedRuns({} as Env, principal, 'fresh', session, 'extend', 'b'.repeat(40), 3))
    .rejects.toMatchObject({ code: 'HEAD_MOVED' });
  expect(approve).not.toHaveBeenCalled();
});

it('a retry attempt suffixes run ids exactly as the native ledger allocates them', async () => {
  normalApproval();
  const first = await prepareGuidedRuns({} as Env, principal, 'fresh', session, 'concurrent', 'a'.repeat(40), 3);
  const retried = await prepareGuidedRuns({} as Env, principal, 'fresh', session, 'concurrent', 'a'.repeat(40), 3, 2);
  expect(retried.map(run => run.id)).toEqual(first.map(run => `${run.id}-r2`));
  expect(first[0].id).toMatch(/^guide-[a-f0-9]{24}-concurrent-0$/);
});

it('v2 build supplies the fixed parallel plan: Codex specialists and a GLM integrator, no planner', async () => {
  normalApproval();
  const [run] = await prepareGuidedRuns({} as Env, principal, 'fresh', v2, 'build', 'a'.repeat(40), 0);
  expect(run.adaptive_team).toBeUndefined();
  expect(run.team.tasks.map((task: Json) => [task.id, task.agent, task.write_paths])).toEqual([
    ['behavior', 0, ['public/tasks.mjs']],
    ['interface', 1, ['public/app.mjs', 'public/index.html', 'public/style.css']],
  ]);
  expect(run.team.integrator_agent).toBe(2);
  expect(run.team.contract).toContain('visibleTasks(tasks,options={})');
  expect(slots(run)).toEqual(['saved-codex', 'saved-codex', 'saved-glm']);
  expect(run.intent).not.toMatch(/Plan two/);
  expect(run.intent).toContain('fixed team plan');
});

it('v2 continuation and concurrent runs each pair one Codex specialist with a GLM integrator', async () => {
  normalApproval();
  const [extend] = await prepareGuidedRuns({} as Env, principal, 'fresh', v2, 'extend', 'a'.repeat(40), 3);
  expect(extend.team.tasks.map((task: Json) => task.id)).toEqual(['bookmarks']);
  expect(slots(extend)).toEqual(['saved-codex', 'saved-glm']);
  const runs = await prepareGuidedRuns({} as Env, principal, 'fresh', v2, 'concurrent', 'a'.repeat(40), 3);
  expect(runs.map((run) => run.team.tasks[0].id)).toEqual(['status-filter', 'title-sort']);
  for (const run of runs) {
    expect(slots(run)).toEqual(['saved-codex', 'saved-glm']);
    expect(run.working_branch_id).toBe('guide-working');
  }
});

it('a guide without the required Codex connection fails clearly before any run starts', async () => {
  approve.mockImplementation(async (_env: Env, _principal: unknown, _repo: string, input: Json) =>
    resolveAdaptiveApproval(input, [connections[0]]));
  for (const guide of [session, v2])
    await expect(prepareGuidedRuns({} as Env, principal, 'fresh', guide, 'build', 'a'.repeat(40), 0))
      .rejects.toMatchObject({ code: 'PROVIDER_MISSING' });
});

it('every guided v2 role thinks at low effort for quick turns', async () => {
  normalApproval();
  const [run] = await prepareGuidedRuns({} as Env, principal, 'fresh', v2, 'build', 'a'.repeat(40), 0);
  expect(run.agents.map((agent: Json) => [agent.connection, agent.reasoning_effort])).toEqual([
    ['saved-codex', 'low'],
    ['saved-codex', 'low'],
    ['saved-glm', 'low'],
  ]);
});

it('a retry after the owner rejected the result gives the agents that feedback', async () => {
  normalApproval();
  const rejected = {
    ...v2,
    steps: [
      { id: 'concurrent', status: 'needs_attention', run_ids: [], evidence: [{ kind: 'owner_rejection', verified: false, reason: 'Theme button is too big. Needs to be smaller' }] },
    ],
  } as unknown as GuidedSession;
  const runs = await prepareGuidedRuns({} as Env, principal, 'fresh', rejected, 'concurrent', 'a'.repeat(40), 3, 2);
  for (const run of runs) expect(run.intent).toContain('Theme button is too big. Needs to be smaller');
  const first = await prepareGuidedRuns({} as Env, principal, 'fresh', v2, 'concurrent', 'a'.repeat(40), 3);
  for (const run of first) expect(run.intent).not.toContain('rejected');
});
