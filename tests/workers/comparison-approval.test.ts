import { expect, it } from 'vitest';
import { approveComparisonStart, deriveComparisonReviewer } from '../../cloudflare/worker/comparison-approval';
import { resolveFixedApproval } from '../../cloudflare/worker/fixed-run-approval';

const connections = [
  { id: 'builder-a', provider: 'codex', model: 'gpt-6.1-sol', version: 1 },
  { id: 'builder-b', provider: 'claude', model: 'claude-sonnet-5-5', version: 1 },
  { id: 'reviewer', provider: 'zai', model: 'glm-5.3-flash', version: 1 },
  { id: 'manual', provider: 'codex', model: 'gpt-6-luna', version: 1 },
];
const input = { mode: 'compare', comparison: { version: 1 }, agents: connections.slice(0, 2).map((c) => ({ connection: c.id, provider: c.provider, model: c.model, strategy: c.id })) };

it('funds three bounded review rounds without treating twelve per round as the aggregate group cap', () => {
  const approved = approveComparisonStart(resolveFixedApproval(input, connections, 50000000), connections, 50000000);
  expect(approved._comparison_reviewer.connection).toBe('reviewer');
  expect(approved._comparison_reviewer_budget.max_requests).toBe(36);
  expect(approved.model_budgets.find((b: any) => b.provider === 'zai').max_requests).toBe(36);
  expect(approved._comparison_reviewer.reasoning_effort).toBeUndefined();
});

it('preserves tighter builder limits when Auto review shares a billing identity', () => {
  const same = connections.slice(1, 2);
  const roster = { ...input, agents: [0, 1].map((i) => ({ connection: same[0].id, provider: same[0].provider, model: same[0].model, strategy: `approach-${i}` })) };
  const fixed = resolveFixedApproval(roster, same, 50000000);
  fixed.model_budgets[0].max_requests = 40;
  expect(approveComparisonStart(fixed, same, 50000000).model_budgets).toEqual(fixed.model_budgets);
});

it('rejects incompatible review approval and never promotes manual-only models into Auto', () => {
  expect(() => deriveComparisonReviewer(connections.slice(3), 50000000)).toThrow();
  const fixed = resolveFixedApproval(input, connections, 50000000);
  expect(() => approveComparisonStart({ ...fixed, agents: fixed.agents.slice(0, 1) }, connections, 50000000)).toThrow('two independent');
  expect(() => approveComparisonStart({ ...fixed, comparison: { version: 1, reviewer: 'manual' } }, connections, 50000000)).toThrow();
  const forged = approveComparisonStart({ ...fixed, _comparison_reviewer: { connection: 'manual' } }, connections, 50000000);
  expect(forged._comparison_reviewer.connection).toBe('reviewer');
});
