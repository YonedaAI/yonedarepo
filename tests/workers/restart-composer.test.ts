import { expect, it } from 'vitest';
import {
  defaultModelBudget,
  editDollarBudget,
  editModelPricing,
  selectedModels,
  serializeModelBudgets,
} from '../../frontend/src/features/exploration/modelBudgets';
import { agentConnectionIssue, initialRun } from '../../frontend/src/features/exploration/restartRun';
import type { Snapshot } from '../../frontend/src/lib/types';

const weakBuild = { setup: [], checks: [{ name: 'site', argv: ['true'] }] };
const currentBuild = {
  setup: [],
  checks: [
    { name: 'site', argv: ['check-site'] },
    { name: 'accessibility', argv: ['check-accessibility'] },
  ],
};
const providers = [{ id: 'key', label: 'Test', provider: 'mimo', model: 'mimo-v2.6-flash' }];
const oldRun = {
  id: 'old',
  intent: 'Build a website',
  criteria: ['Accessible navigation'],
  context: [],
  policy: { build: weakBuild },
  model_budgets: [{
    provider: 'mimo',
    model: 'mimo-v2.6-flash',
    max_requests: 60,
    max_output_tokens: 4096,
    max_execution_ms: 600_000,
    spend_limit_microusd: 2_000_000,
    pricing: {
      input_microusd_per_million: 140_000,
      output_microusd_per_million: 280_000,
      source: 'owner-approved conservative rates',
    },
    requests: 11,
    charged_microusd: 500_000,
  }],
};
const snapshot: Snapshot = {
  repository: {
    id: 'repo', name: 'Repo', version: 3, head_commit: 'head', published_commit: 'head',
    status: 'ready', pending: null, remote: { namespace: 'test', name: 'site' },
    policy: {
      suite: 'commands-v1', version: 'current', environment: 'test',
      required_checks: ['site', 'accessibility'], build: currentBuild,
    },
  },
  runs: [],
  executions: ['root-1', 'root-2', 'child'].map((id) => ({
    id, run_id: 'old', role: 'coding', connection: 'key', provider: 'mimo',
    model: 'mimo-v2.6-flash', strategy: id, ...(id === 'child' ? { parent_execution: 'root-1' } : {}),
  })),
  candidates: [], evaluations: [], decisions: [], artifacts: [], nodes: [], edges: [], seq: 1,
};

it('restarting preserves the current stronger build policy and the historical evidence', () => {
  const draft = initialRun(snapshot, oldRun);
  expect(JSON.parse(draft.policy)).toEqual(currentBuild);
  expect(oldRun.policy.build).toEqual(weakBuild);
});

it('restarts roots with their approved model limits while resetting usage', () => {
  const draft = initialRun(snapshot, oldRun);
  expect(draft.agents.map((agent) => agent.strategy)).toEqual(['root-1', 'root-2']);
  const [budget] = serializeModelBudgets(selectedModels(draft.agents, providers), draft.budgets);
  expect(budget.spend_limit_microusd).toBe(2_000_000);
  expect(budget.max_requests).toBe(60);
  expect(budget.pricing).toEqual(oldRun.model_budgets[0].pricing);
  expect(budget).not.toHaveProperty('requests');
  expect(budget).not.toHaveProperty('charged_microusd');
});

it('requires explicit connection selection when a restored connection disappeared or changed', () => {
  const agent = initialRun(snapshot, oldRun).agents[0];
  expect(agentConnectionIssue(agent, [])).toContain('unavailable');
  const changed = [{ ...providers[0], model: 'different-model' }];
  expect(agentConnectionIssue(agent, changed)).toContain('different provider or model');
  const reselected = {
    ...agent, expectedProvider: undefined, expectedModel: undefined, fromPreviousRun: false,
  };
  expect(agentConnectionIssue(reselected, changed)).toBe('');
});

it('seeds known conservative rates when the owner enters a dollar budget', () => {
  const [model] = selectedModels(initialRun(snapshot, oldRun).agents, providers);
  const draft = editDollarBudget(model, defaultModelBudget(model), '2.50');
  expect(draft.ratesApproved).toBe(true);
  const [budget] = serializeModelBudgets([model], { [model.key]: draft });
  expect(budget.spend_limit_microusd).toBe(2_500_000);
  expect(budget.pricing?.input_microusd_per_million).toBe(140_000);
  const [uncapped] = serializeModelBudgets([model], {
    [model.key]: editDollarBudget(model, draft, ''),
  });
  expect(uncapped.spend_limit_microusd).toBeNull();
  expect(uncapped.max_requests).toBe(budget.max_requests);
  expect(uncapped.max_execution_ms).toBe(budget.max_execution_ms);
});

it('requires manual advanced rates for an unknown model dollar budget', () => {
  const model = { key: 'custom', provider: 'mimo', model: 'custom-model', roots: 1, connections: 1 };
  const draft = editDollarBudget(model, defaultModelBudget(model), '1');
  expect(() => serializeModelBudgets([model], { [model.key]: draft })).toThrow('Advanced limits');
  const priced = editModelPricing(editModelPricing(draft, 'inputRate', '0.10'), 'outputRate', '0.20');
  const [budget] = serializeModelBudgets([model], { [model.key]: priced });
  expect(budget.pricing?.input_microusd_per_million).toBe(100_000);
  expect(budget.pricing?.output_microusd_per_million).toBe(200_000);
});

it('defaults to no request or dollar cap and preserves an uncapped restart', () => {
  const [model] = selectedModels(initialRun(snapshot, oldRun).agents, providers);
  const [budget] = serializeModelBudgets([model], {});
  expect(budget.max_requests).toBeNull();
  expect(budget.spend_limit_microusd).toBeNull();
  const draft = initialRun(snapshot, { ...oldRun, model_budgets: [budget] });
  expect(draft.budgets[model.key].requests).toBe('');
  expect(serializeModelBudgets([model], draft.budgets)[0].max_requests).toBeNull();
});
