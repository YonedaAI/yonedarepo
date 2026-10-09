import { expect, it } from 'vitest';
import { reconcileTeam, removeTeamTask, restoreTeam, seedTeam, serializeTeam, teamSubmission, type TeamDraft } from '../../frontend/src/features/team/teamDraft';
import { canRetryTeamTask, dependencyBlockers, integratedExecutions, runCandidates, teamTasks } from '../../frontend/src/features/team/teamView';
import { initialRun } from '../../frontend/src/features/exploration/restartRun';
import { runDraft } from '../../frontend/src/features/exploration/runDraft';
import { canCancelRun, runHasActiveAttempts } from '../../frontend/src/features/exploration/runControlState';
import type { Snapshot } from '../../frontend/src/lib/types';

const agents = ['search', 'rsvp', 'integrator'].map((id) => ({ id, connection: `key-${id}`, strategy: id }));
function manualDraft(): TeamDraft { return { ...seedTeam(agents), contract: 'Separate modules with a shared interface.', integratorId: agents[2].id, integrationPaths: 'public/index.html', tasks: [{ id: 'event-search', title: 'Search', instructions: 'Implement search', agentId: agents[0].id, dependsOn: [], writePaths: 'public/search.mjs' }, { id: 'event-rsvp', title: 'Registration', instructions: 'Implement registration', agentId: agents[1].id, dependsOn: [], writePaths: 'public/rsvp.mjs' }] }; }
const plan = serializeTeam(manualDraft(), agents);
const run = { id: 'team', mode: 'collaborate', team_plan: plan, status: 'exploring', agents: agents.map((agent) => ({ ...agent, provider: 'mimo', model: 'mimo-v2.6-flash' })) };
const snapshot: Snapshot = {
  repository: { id: 'repo', name: 'Team', head_commit: 'base', published_commit: '', version: 1, status: 'ready', pending: null, remote: { namespace: 'test', name: 'repo' } },
  runs: [run], executions: [{ id: 'search', run_id: 'team', role: 'coding', team_role: 'worker' }, { id: 'integrator', run_id: 'team', role: 'coding', team_role: 'integrator' }],
  candidates: [], evaluations: [], decisions: [], artifacts: [], nodes: [], edges: [], seq: 1,
};

it('agent removal clears stable assignments rather than shifting roles', () => {
  const fourth = { id: 'replacement', connection: 'key-new', strategy: 'replacement' };
  const draft = manualDraft();
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

it('rejects cycles, overlapping ownership and unused manual agents', () => {
  const cyclic = manualDraft();
  cyclic.tasks[0].dependsOn = [cyclic.tasks[1].id];
  cyclic.tasks[1].dependsOn = [cyclic.tasks[0].id];
  expect(() => serializeTeam(cyclic, agents)).toThrow('cycle');
  const overlap = manualDraft();
  overlap.tasks[0].writePaths = 'public/';
  expect(() => serializeTeam(overlap, agents)).toThrow('disjoint');
  expect(() => serializeTeam(manualDraft(), [...agents, { id: 'unused', connection: 'key', strategy: 'unused' }])).toThrow('every configured');
});

it('bounds source scopes and rejects nested Git metadata and absolute paths', () => {
  for (const path of ['public/.GIT/config', '/tmp/code', 'public/../secret', 'public//search', 'C:source', 'public/search.mjs\npublic/search.mjs']) {
    const unsafe = manualDraft();
    unsafe.tasks[0].writePaths = path;
    expect(() => serializeTeam(unsafe, agents)).toThrow('safe relative');
  }
  const prefix = manualDraft();
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
  const planning = { ...run, status: 'planning' };
  expect(runHasActiveAttempts({ ...snapshot, executions: [] }, planning)).toBe(true);
  expect(canCancelRun(planning, true)).toBe(true);
});

it('automatic brief-first submission omits hidden manual configuration without changing the roster', () => {
  const single = [agents[0]];
  const blank = seedTeam(single);
  expect(blank.contract).toBe('');
  expect(blank.tasks).toHaveLength(1);
  expect(teamSubmission('collaborate', false, blank, single, true)).toEqual({});
  expect(single).toHaveLength(1);
  expect(() => teamSubmission('collaborate', false, blank, single, false)).toThrow('Automatic team planning');
  expect(teamSubmission('compare', false, blank, single, false)).toEqual({});
});

it('manual planning supports one agent owning a task and final integration', () => {
  const single = [agents[0]];
  const draft = { ...seedTeam(single), contract: 'Preserve the current interface.', integrationPaths: 'public/index.html', tasks: [{ id: 'content', title: 'Update content', instructions: 'Implement the approved change', agentId: single[0].id, dependsOn: [], writePaths: 'public/content.mjs' }] };
  expect(serializeTeam(draft, single)).toMatchObject({ integrator_agent: 0, tasks: [{ agent: 0 }] });
  expect(teamSubmission('collaborate', true, draft, single, true)).toHaveProperty('team');
});

it('removes every manual task and clears dangling dependencies with a clear empty-plan error', () => {
  const draft = manualDraft();
  draft.tasks[1].dependsOn = [draft.tasks[0].id];
  const first = removeTeamTask(draft, draft.tasks[0].id);
  expect(first.tasks[0].dependsOn).toEqual([]);
  const empty = removeTeamTask(first, first.tasks[0].id);
  expect(empty.tasks).toEqual([]);
  expect(() => serializeTeam(empty, agents)).toThrow('Add at least one worker task');
  expect(teamSubmission('collaborate', false, empty, agents, true)).toEqual({});
});

it('keeps a generated previous plan as provenance and replans automatic restarts from their brief', () => {
  const automaticRun = { ...run, team_planning: 'automatic', context: ['earlier-decision'] };
  const restarted = initialRun(snapshot, automaticRun);
  const draft = runDraft(snapshot, restarted);
  expect(draft.mode).toBe('collaborate');
  expect(draft.previousAutomatic).toBe(true);
  expect(draft.previousTeamPlan).toEqual(plan);
  expect(draft.team).toBeUndefined();
  expect(draft.context).toEqual(['earlier-decision']);
});

it('carries published team context without converting a generated plan into a manual update', () => {
  const published = { ...snapshot, repository: { ...snapshot.repository, published_commit: 'published' }, runs: [{ ...run, team_planning: 'automatic' }], candidates: [{ id: 'candidate', run_id: run.id, execution: 'integrator', revision: { commit: 'published' } }], decisions: [{ id: 'decision', run_id: run.id, candidate: 'candidate', status: 'published', target: { commit: 'published' } }], nodes: [{ id: 'decision', kind: 'decision', label: 'Earlier release', author: 'owner', recorded_at: 1, data: {} }] };
  const draft = runDraft(published);
  expect(draft.context).toContain('decision');
  expect(draft.previousAutomatic).toBe(true);
  expect(draft.team).toBeUndefined();
  expect(draft.agents).toHaveLength(3);
});

it('withholds retry while the same roster agent owns another active source task', () => {
  const failed = { task_id: 'first', agent: 0, status: 'failed', epoch: 1, revision: 1 };
  for (const status of ['queued', 'running', 'capturing', 'evaluating']) {
    const active = { task_id: 'next', agent: 0, status };
    expect(canRetryTeamTask(failed, [failed, active], run)).toBe(false);
    expect(canRetryTeamTask(failed, [failed, { ...active, agent: 1 }], run)).toBe(true);
  }
  expect(canRetryTeamTask(failed, [failed, { task_id: 'next', agent: 0, status: 'complete' }], run)).toBe(true);
});
