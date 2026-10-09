import { expect, it } from 'vitest';
import { reconcileTeam, restoreTeam, seedTeam, serializeTeam } from '../../frontend/src/features/team/teamDraft';
import { canRetryTeamTask, dependencyBlockers, integratedExecutions, runCandidates, teamTasks } from '../../frontend/src/features/team/teamView';
import { initialRun } from '../../frontend/src/features/exploration/restartRun';
import { runDraft } from '../../frontend/src/features/exploration/runDraft';
import { canCancelRun } from '../../frontend/src/features/exploration/runControlState';
import type { Snapshot } from '../../frontend/src/lib/types';

const agents = ['search', 'rsvp', 'integrator'].map((id) => ({ id, connection: `key-${id}`, strategy: id }));
const plan = serializeTeam(seedTeam(agents), agents);
const run = { id: 'team', mode: 'collaborate', team_plan: plan, status: 'exploring', agents: agents.map((agent) => ({ ...agent, provider: 'mimo', model: 'mimo-v2.6-flash' })) };
const snapshot: Snapshot = {
  repository: { id: 'repo', name: 'Team', head_commit: 'base', published_commit: '', version: 1, status: 'ready', pending: null, remote: { namespace: 'test', name: 'repo' } },
  runs: [run], executions: [{ id: 'search', run_id: 'team', role: 'coding', team_role: 'worker' }, { id: 'integrator', run_id: 'team', role: 'coding', team_role: 'integrator' }],
  candidates: [], evaluations: [], decisions: [], artifacts: [], nodes: [], edges: [], seq: 1,
};

it('agent removal clears stable assignments rather than shifting roles', () => {
  const fourth = { id: 'replacement', connection: 'key-new', strategy: 'replacement' };
  const draft = seedTeam([...agents, fourth]);
  const roster = [agents[1], agents[2], fourth];
  const reconciled = reconcileTeam(draft, roster);
  expect(reconciled.tasks[0].agentId).toBe('');
  expect(reconciled.tasks[1].agentId).toBe('rsvp');
  expect(reconciled.integratorId).toBe('integrator');
  expect(() => serializeTeam(reconciled, roster)).toThrow('Choose an agent');
  reconciled.tasks[0].agentId = fourth.id;
  expect(serializeTeam(reconciled, roster).tasks.map((task) => task.agent)).toEqual([2, 0]);
});

it('preserves blocked roles, frozen assignments and mode during restart', () => {
  const restarted = initialRun(snapshot, run);
  expect(restarted.agents.map((agent) => agent.connection)).toEqual(agents.map((agent) => agent.connection));
  expect(restarted.mode).toBe('collaborate');
  expect(serializeTeam(restoreTeam(restarted.team, restarted.agents), restarted.agents)).toEqual(plan);
  const draft = runDraft(snapshot, restarted);
  expect(draft.mode).toBe('collaborate');
  expect(serializeTeam(draft.team!, draft.agents)).toEqual(plan);
});

it('rejects cycles, overlapping ownership, unused agents and integrator worker assignments', () => {
  const cyclic = seedTeam(agents);
  cyclic.tasks[0].dependsOn = [cyclic.tasks[1].id];
  cyclic.tasks[1].dependsOn = [cyclic.tasks[0].id];
  expect(() => serializeTeam(cyclic, agents)).toThrow('cycle');
  const overlap = seedTeam(agents);
  overlap.tasks[0].writePaths = 'public/';
  expect(() => serializeTeam(overlap, agents)).toThrow('disjoint');
  const integratorWorker = seedTeam(agents);
  integratorWorker.tasks[0].agentId = agents[2].id;
  expect(() => serializeTeam(integratorWorker, agents)).toThrow('separate');
  expect(() => serializeTeam(seedTeam(agents), [...agents, { id: 'unused', connection: 'key', strategy: 'unused' }])).toThrow('every configured');
});

it('bounds source scopes and rejects nested Git metadata and absolute paths', () => {
  for (const path of ['public/.GIT/config', '/tmp/code', 'public/../secret', 'public//search', 'C:source', 'public/search.mjs\npublic/search.mjs']) {
    const unsafe = seedTeam(agents);
    unsafe.tasks[0].writePaths = path;
    expect(() => serializeTeam(unsafe, agents)).toThrow('safe relative');
  }
  const prefix = seedTeam(agents);
  prefix.tasks[0].writePaths = 'public/search/';
  expect(serializeTeam(prefix, agents).tasks[0].write_paths).toEqual(['public/search/']);
});

it('presents task dependencies and only the final integrated execution as a candidate', () => {
  const tasks = [
    { id: 'team:integrate', task_id: 'integrate', run_id: 'team', role: 'integrator', depends_on: ['event-search', 'event-rsvp'], status: 'blocked' },
    { id: 'team:rsvp', task_id: 'event-rsvp', run_id: 'team', status: 'failed', epoch: 2, revision: 1 },
    { id: 'team:search', task_id: 'event-search', run_id: 'team', status: 'complete' },
    { id: 'other', task_id: 'other', run_id: 'other', status: 'failed' },
  ];
  const view = teamTasks({ ...snapshot, team_tasks: tasks }, run);
  expect(view.map((task) => task.task_id)).toEqual(['event-search', 'event-rsvp', 'integrate']);
  expect(dependencyBlockers(view[2], view)).toEqual(['event-rsvp']);
  expect(canRetryTeamTask(view[1], view, run)).toBe(true);
  expect(canRetryTeamTask(view[1], [...view.slice(0, 2), { ...view[2], status: 'running', execution_id: 'started' }], run)).toBe(false);
  expect(canRetryTeamTask(view[1], view, { ...run, status: 'cancelled' })).toBe(false);
  expect(integratedExecutions(snapshot, run).map((execution) => execution.id)).toEqual(['integrator']);
});

it('resolves the current integration candidate after retry instead of an earlier cancelled capture', () => {
  const state = { ...snapshot, candidates: [{ id: 'old', run_id: run.id, execution: 'integrator', status: 'cancelled' }, { id: 'current', run_id: run.id, execution: 'integrator', status: 'evaluating' }], team_tasks: [{ run_id: run.id, role: 'integrator', candidate_id: 'current', execution_id: 'integrator' }] };
  expect(runCandidates(state, run).map((candidate) => candidate.id)).toEqual(['current']);
  expect(runCandidates({ ...state, team_tasks: [] }, run)).toEqual([]);
});

it('rejects owner retry after a transitive dependent starts or the retry budget is exhausted', () => {
  const failed = { task_id: 'search', status: 'failed', epoch: 1, revision: 1 };
  const tasks = [failed, { task_id: 'summary', depends_on: ['search'], status: 'blocked', epoch: 0 }, { task_id: 'integrate', depends_on: ['summary'], status: 'running', epoch: 1 }];
  expect(canRetryTeamTask(failed, tasks, run)).toBe(false);
  expect(canRetryTeamTask({ ...failed, revision: 3 }, [failed], run)).toBe(false);
});

it('retains cancellation when a team task failed while parallel work remains active', () => {
  expect(canCancelRun({ ...run, status: 'failed' }, true)).toBe(true);
  expect(canCancelRun({ ...run, status: 'failed' }, false)).toBe(true);
  expect(canCancelRun({ ...run, status: 'accepted' }, true)).toBe(false);
  expect(canCancelRun({ ...run, status: 'cancelled' }, false)).toBe(false);
});
