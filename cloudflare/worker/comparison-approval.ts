import { resolveAdaptiveApproval } from './adaptive-approval';
import type { Json } from './types';

const invalid = (message: string) => Object.assign(new Error(message), { code: 'INVALID_INPUT' });

/** Auto chooses only eligible connected catalog models; browser reviewer identities are ignored. */
export function deriveComparisonReviewer(connections: Json[], limit: number) {
  const chosen = resolveAdaptiveApproval(
    {
      mode: 'compare',
      adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'review' }] },
    },
    connections,
    Math.min(limit, 50000000),
  );
  const agent = chosen.agents[0];
  const reviewer: Json = {};
  for (const field of ['connection', 'provider', 'model', 'routing', 'version'])
    if (agent[field] !== undefined) reviewer[field] = agent[field];
  return {
    _comparison_reviewer: reviewer,
    _comparison_reviewer_budget: { ...chosen.model_budgets[0], max_requests: 36 },
  };
}

/** Original builder group bounds win when the reviewer shares their billing identity. */
export function approveComparisonStart(input: Json, connections: Json[], limit: number): Json {
  if (input.comparison == null) return input;
  if (
    input.comparison.version !== 1 ||
    Object.keys(input.comparison).some((key) => key !== 'version') ||
    input.mode !== 'compare' ||
    input.agents?.length !== 2 ||
    input.adaptive_team != null ||
    input.team != null ||
    input.delegation?.enabled === true
  )
    throw invalid('Comparison requires two independent builders and version 1 review approval.');
  const trusted = deriveComparisonReviewer(connections, limit);
  const group = trusted._comparison_reviewer_budget;
  const budgets = [...input.model_budgets];
  if (
    !budgets.some(
      (budget: Json) => budget.provider === group.provider && budget.model === group.model,
    )
  )
    budgets.push(group);
  return { ...input, ...trusted, model_budgets: budgets };
}
