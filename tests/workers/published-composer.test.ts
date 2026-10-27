import { expect, it } from 'vitest';
import { approachPresets } from '../../frontend/src/features/exploration/approaches';
import {
  selectedModels,
  serializeModelBudgets,
} from '../../frontend/src/features/exploration/modelBudgets';
import {
  preservePublishedCriteria,
  publishedContext,
  publishedRun,
} from '../../frontend/src/features/exploration/publishedRun';
import {
  agentConnectionIssue,
  initialRun,
} from '../../frontend/src/features/exploration/restartRun';
import { defaultConnections, runDraft } from '../../frontend/src/features/exploration/runDraft';
import {
  defaultRunAgents,
  hasPublishedWork,
} from '../../frontend/src/features/exploration/runDefaults';
import type { Snapshot } from '../../frontend/src/lib/types';

const commit = 'b'.repeat(40);
const providers = [
  { id: 'glm', label: 'GLM', provider: 'zai', model: 'glm-5.3-flash' },
  { id: 'mimo', label: 'MiMo', provider: 'mimo', model: 'mimo-v2.6-flash' },
];
const node = (id: string, author = 'owner') => ({
  id,
  author,
  kind: 'constraint',
  label: id,
  data: {},
  recorded_at: 1,
});
function snapshot(): Snapshot {
  const result: Snapshot = {
    repository: {
      id: 'repo',
      name: 'Website',
      version: 2,
      head_commit: commit,
      published_commit: commit,
      status: 'ready',
      pending: null,
      remote: { namespace: 'test', name: 'site' },
      site: { commit, digest: 'site-digest' },
    },
    capabilities: {
      agent_limits: {
        min_root_agents: 1,
        max_root_agents: 6,
        max_run_executions: 12,
        max_delegation_depth: 2,
        max_run_model_requests: null,
      },
    },
    runs: [
      {
        id: 'release',
        intent: 'Build a cycling website',
        criteria: ['Keyboard accessible'],
        context: ['constraint:original'],
      },
      { id: 'newer-failure', intent: 'Rejected redesign', status: 'failed', context: [] },
    ],
    executions: [
      {
        id: 'first',
        run_id: 'release',
        role: 'coding',
        connection: 'glm',
        provider: 'zai',
        model: 'glm-5.3-flash',
        strategy: approachPresets[0].instructions,
      },
      {
        id: 'winner',
        run_id: 'release',
        role: 'coding',
        connection: 'mimo',
        provider: 'mimo',
        model: 'mimo-v2.6-flash',
        strategy: approachPresets[2].instructions,
      },
      {
        id: 'failed',
        run_id: 'newer-failure',
        role: 'coding',
        connection: 'glm',
        provider: 'zai',
        model: 'glm-5.3-flash',
        strategy: 'Unpublished redesign',
      },
    ],
    candidates: [
      {
        id: 'chosen',
        execution: 'winner',
        run_id: 'release',
        revision: { commit },
        evaluation: 'evaluation:chosen',
      },
    ],
    decisions: [
      {
        id: 'decision:release',
        run_id: 'release',
        candidate: 'chosen',
        target: { commit },
        status: 'published',
        rationale: 'The visual design is clearer',
      },
    ],
    evaluations: [],
    artifacts: [],
    nodes: [],
    edges: [],
    seq: 1,
  };
  return result;
}

it('fresh updates use one Auto seed while explicit restarts restore recorded model preferences', () => {
  const state = snapshot();
  const before = structuredClone(state);
  const agents = defaultRunAgents(state);
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({
    connection: '',
    role: 'auto',
  });
  expect(agents[0]).not.toHaveProperty('expectedModel');
  expect(agents[0]).not.toHaveProperty('fromPreviousRun');
  const restarting = runDraft(state, initialRun(state, state.runs[0]));
  expect(restarting.agents).toHaveLength(2);
  expect(restarting.agents[1]).toMatchObject({
    connection: 'mimo',
    expectedProvider: 'mimo',
    expectedModel: 'mimo-v2.6-flash',
    strategy: approachPresets[2].instructions,
    fromPreviousRun: true,
  });
  expect(restarting.agents[1].id).not.toBe('winner');
  expect(state).toEqual(before);
});

it('keeps the winning attempt as publication evidence while a fresh brief uses one Auto seed', () => {
  const state = snapshot();
  state.executions[1].parent_execution = 'first';
  state.executions[1].strategy = 'Keep the approved editorial design with warm colors';
  const draft = runDraft(state);
  expect(draft.agents).toHaveLength(1);
  expect(draft.agents[0]).toMatchObject({ connection: '', role: 'auto' });
  expect(draft.publication?.execution?.strategy).toBe(state.executions[1].strategy);
  expect(draft.publication?.execution?.parent_execution).toBe('first');
  expect(draft.agents[0].id).not.toBe('winner');
  expect(draft.intent).toBe('');
  expect(draft.restartOf).toBeUndefined();
  expect(draft.mode).toBe('compare');
  expect(draft.publication?.decision.id).toBe('decision:release');
});

it('uses canonical published source when an older website is hosted and a newer decision is pending', () => {
  const state = snapshot();
  state.repository.site!.commit = 'a'.repeat(40);
  state.decisions.push({ ...state.decisions[0], id: 'unpublished', status: 'pending' });
  expect(publishedRun(state)?.decision.id).toBe('decision:release');
  const draft = runDraft(state);
  expect(draft.publication?.candidate.revision.commit).toBe(commit);
  expect(draft.publication?.decision.target.commit).toBe(state.repository.published_commit);
  expect(draft.publication?.run.id).toBe('release');
  expect(draft.criteria).toContain('Keyboard accessible');
  delete state.repository.site;
  expect(hasPublishedWork(state)).toBe(true);
  expect(defaultRunAgents(state)).toHaveLength(1);
  expect(defaultRunAgents(state)[0]).toMatchObject({ connection: '', role: 'auto' });
  state.repository.published_commit = 'c'.repeat(40);
  expect(publishedRun(state)).toBeUndefined();
});

it('carries the selected decision, brief, checked revision, artifacts and lineage assertions, excluding rival work', () => {
  const state = snapshot();
  state.executions[1].parent_execution = 'parent';
  state.executions[1].context = ['constraint:original'];
  state.executions.push(
    { id: 'parent', run_id: 'release', role: 'coding' },
  );
  state.artifacts = [
    { id: 'artifact:winner', producer: 'winner' },
    { id: 'artifact:parent', producer: 'parent' },
    { id: 'artifact:rival', producer: 'first' },
    { id: 'artifact:failed', producer: 'failed' },
  ];
  state.nodes = [
    ...[
      'decision:release',
      'intent:release',
      'chosen',
      'evaluation:chosen',
      'winner',
      'constraint:original',
      'artifact:winner',
      'artifact:parent',
      'artifact:rival',
      'artifact:failed',
      'linked-assertion',
    ].map((id) => node(id)),
    node('finding:winner', 'winner'),
    node('constraint:parent', 'parent'),
    node('finding:rival', 'first'),
    node('finding:failed', 'failed'),
  ];
  state.edges = [
    {
      source: 'artifact:winner',
      target: 'linked-assertion',
      relation: 'states',
      evidence: 'fixture',
    },
  ];
  const before = structuredClone(state);
  const draft = runDraft(state);
  expect(draft.context).toEqual(
    expect.arrayContaining([
      'decision:release',
      'intent:release',
      'chosen',
      'evaluation:chosen',
      'winner',
      'constraint:original',
      'artifact:winner',
      'artifact:parent',
      'finding:winner',
      'constraint:parent',
      'linked-assertion',
    ]),
  );
  expect(draft.context).not.toEqual(expect.arrayContaining(['artifact:rival']));
  expect(draft.context).not.toEqual(expect.arrayContaining(['artifact:failed']));
  expect(draft.context).not.toContain('finding:rival');
  expect(draft.context).not.toContain('finding:failed');
  expect(state).toEqual(before);
});

it('bounds inherited context and handles duplicate, dangling and cyclic references', () => {
  const state = snapshot();
  state.nodes = [
    node('decision:release'),
    node('intent:release'),
    ...Array.from({ length: 60 }, (_, index) => node(`finding:${index}`, 'winner')),
  ];
  state.executions[1].parent_execution = 'winner';
  state.runs[0].context = ['missing', 'decision:release'];
  const context = publishedContext(state, publishedRun(state)!);
  expect(context.ids).toHaveLength(50);
  expect(context.total).toBe(62);
  expect(context.ids.slice(0, 2)).toEqual(['decision:release', 'intent:release']);
  expect(new Set(context.ids).size).toBe(50);
  expect(context.ids).not.toContain('missing');
});

it('retains criteria and current checks for fresh Auto work, restoring historical model limits only on explicit restart', () => {
  const state = snapshot();
  const currentBuild = {
    setup: [],
    checks: [{ name: 'current', argv: ['node', '--check', 'app.js'] }],
  };
  state.repository.policy = {
    suite: 'commands-v1',
    version: 'current',
    environment: 'test',
    required_checks: ['current'],
    build: currentBuild,
  };
  state.runs[0].policy = { build: { checks: [{ name: 'outdated' }] } };
  state.runs[0].model_budgets = providers.map((provider) => ({
    provider: provider.provider,
    model: provider.model,
    max_requests: null,
    max_output_tokens: 4096,
    max_execution_ms: 1_200_000,
    spend_limit_microusd: null,
    pricing: null,
    requests: 28,
    charged_microusd: 123,
  }));
  const draft = runDraft(state);
  expect(draft.criteria.split('\n')).toEqual(['Keyboard accessible', preservePublishedCriteria]);
  expect(JSON.parse(draft.policy)).toEqual(currentBuild);
  expect(draft.agents).toHaveLength(1);
  expect(draft.agents[0]).toMatchObject({ connection: '', role: 'auto' });
  expect(selectedModels(draft.agents, providers)).toEqual([]);
  expect(draft.budgets).toEqual({});
  const before = structuredClone(state);
  const restarting = runDraft(state, initialRun(state, state.runs[0]));
  expect(restarting.criteria).toBe('Keyboard accessible');
  expect(JSON.parse(restarting.policy)).toEqual(currentBuild);
  const models = selectedModels(restarting.agents, providers);
  expect(models).toHaveLength(2);
  expect(Object.keys(restarting.budgets)).toEqual(models.map((model) => model.key));
  const budgets = serializeModelBudgets(models, restarting.budgets);
  for (const budget of budgets) {
    expect(budget.max_execution_ms).toBe(1_200_000);
    expect(budget.max_requests).toBeNull();
    expect(budget.spend_limit_microusd).toBeNull();
    expect(budget).not.toHaveProperty('requests');
    expect(budget).not.toHaveProperty('charged_microusd');
  }
  expect(state).toEqual(before);
  state.runs[0].criteria = Array.from({ length: 32 }, (_, index) => `Criterion ${index}`);
  expect(runDraft(state).criteria.split('\n')).toHaveLength(32);
});

it('requires deliberate replacement of missing or changed restart connections while fresh Auto stays unresolved', () => {
  const state = snapshot();
  const draft = runDraft(state, initialRun(state, state.runs[0]));
  const available = providers.slice(0, 1);
  const hydrated = defaultConnections(draft.agents, available);
  expect(hydrated[1].connection).toBe('mimo');
  expect(agentConnectionIssue(hydrated[1], available)).toContain('unavailable');
  const changed = [{ ...providers[1], model: 'another-model' }];
  expect(agentConnectionIssue(defaultConnections(draft.agents, changed)[1], changed)).toContain(
    'different provider or model',
  );
  expect(
    defaultConnections(
      runDraft(state).agents,
      available,
    )[0].connection,
  ).toBe('');
});

it('keeps old releases usable when hosted connection history is missing, without inventing a previous model', () => {
  const state = snapshot();
  delete state.executions[1].connection;
  delete state.executions[1].model;
  const draft = runDraft(state);
  expect(draft.agents[0].connection).toBe('');
  expect(draft.agents[0].role).toBe('auto');
  expect(agentConnectionIssue(draft.agents[0], providers)).toBe('');
  expect(draft.publication?.execution).not.toHaveProperty('model');
  const restarted = runDraft(state, initialRun(state, state.runs[0]));
  expect(restarted.agents[1].connection).toBe('');
  expect(restarted.agents[1].expectedModel).toBeUndefined();
  expect(agentConnectionIssue(restarted.agents[1], providers)).toContain('unavailable');
  state.executions = [];
  expect(runDraft(state).agents[0]).toMatchObject({ connection: '', role: 'auto' });
  expect(runDraft(state).criteria).toContain(preservePublishedCriteria);
  expect(runDraft(state).publication?.candidate.revision.commit).toBe(commit);
  state.decisions = [];
  expect(runDraft(state).agents[0]).toMatchObject({ connection: '', role: 'auto' });
  expect(runDraft(state).criteria).toContain('Preserve existing behavior and checks');
  expect(runDraft(state).publication).toBeUndefined();
});

it('keeps restart semantics separate and initial builds editable without published assumptions', () => {
  const state = snapshot();
  const restarting = runDraft(state, initialRun(state, state.runs[0]));
  expect(restarting.publication).toBeUndefined();
  expect(restarting.restartOf).toBe('release');
  expect(restarting.agents).toHaveLength(2);
  expect(restarting.agents.map((agent) => agent.connection)).toEqual(['glm', 'mimo']);
  expect(restarting.mode).toBe('compare');
  expect(restarting.intent).toBe('Build a cycling website');
  state.decisions = [];
  delete state.repository.site;
  const newProject = runDraft(state);
  expect(newProject.agents).toHaveLength(1);
  expect(newProject.agents[0]).toMatchObject({ connection: '', role: 'auto' });
  expect(newProject.intent).toBe('');
  expect(newProject.mode).toBe('compare');
  expect(newProject.context).toEqual([]);
  expect(newProject.criteria).not.toContain(preservePublishedCriteria);
});
