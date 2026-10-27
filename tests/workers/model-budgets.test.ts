import { expect, it } from 'vitest';
import { checkLedger } from '../../cloudflare/worker/runtime';

const budget = {
  provider: 'zai', model: 'glm-4.7-flash', max_requests: 3,
  max_output_tokens: 512, max_execution_ms: 120000,
  spend_limit_microusd: 1000000,
  pricing: { input_microusd_per_million: 1000000,
    output_microusd_per_million: 5000000, source: 'owner-approved conservative rates' },
};

it('fences longer execution limits during ledger rollout', () => {
  const request = { model_budgets: [{ ...budget, max_execution_ms: 1800000 }] };
  const capabilities = { artifact_reads: 2, model_budgets: 1 };
  expect(() => checkLedger({ capabilities }, request)).toThrow('updating');
  expect(() => checkLedger({ capabilities: { ...capabilities, max_execution_ms: 1800000 } }, request)).not.toThrow();
});

it('blocks approved budgets on older ledgers before inference', () => {
  const request = { model_budgets: [budget] };
  expect(() => checkLedger({ capabilities: { artifact_reads: 2 } }, request)).toThrow('updating');
  expect(() => checkLedger({ capabilities: { artifact_reads: 2 } }, { restart_of: 'previous' })).toThrow('updating');
  expect(() => checkLedger({ capabilities: { artifact_reads: 2, model_budgets: 1 } }, request)).not.toThrow();
  const uncapped = { model_budgets: [{ ...budget, max_requests: null }] };
  expect(() => checkLedger({ capabilities: { artifact_reads: 2, model_budgets: 1 } }, uncapped)).toThrow('updating');
  expect(() => checkLedger({ capabilities: { artifact_reads: 2, model_budgets: 1, optional_model_requests: 1 } }, uncapped)).not.toThrow();
});
