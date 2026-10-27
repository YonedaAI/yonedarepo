import { resolveRunRoster } from './run-roster';
import type { Json } from './types';

/** Older clients keep their fixed roster; new work still receives trusted shared accounting. */
export function resolveFixedApproval(input: Json, connections: Json[], limit: number): Json {
  if (!Array.isArray(input.agents) || !input.agents.length || input.agents.length > 6)
    throw Object.assign(new Error('Choose between one and six configured agents.'), {
      code: 'INVALID_INPUT',
    });
  for (const agent of input.agents) {
    if (
      !connections.some(
        (connection) =>
          connection.id === (agent.connection ?? agent.provider) &&
          connection.provider === agent.provider &&
          connection.model === agent.model,
      )
    )
      throw Object.assign(new Error('A selected connection or model has changed.'), {
        code: 'PROVIDER_MISSING',
      });
  }
  const approved = resolveRunRoster(
    {
      ...input,
      mode: input.mode ?? 'compare',
      adaptive_team: {
        version: 1,
        requested_agents: input.agents.map((agent: Json) => ({
          connection: agent.connection ?? agent.provider,
          role: 'auto',
          ...(agent.reasoning_effort == null ? {} : { reasoning_effort: agent.reasoning_effort }),
        })),
      },
    },
    connections,
    limit,
  );
  approved.agents = approved.agents.map((agent: Json, index: number) => ({
    ...agent,
    strategy: input.agents[index].strategy,
  }));
  const supplied = input.model_budgets;
  if (supplied !== undefined) {
    if (!Array.isArray(supplied) || supplied.length !== approved.model_budgets.length)
      throw invalid('Model budgets must exactly match the saved selected model groups.');
    const expected = new Set(approved.model_budgets.map((b: Json) => `${b.provider}/${b.model}`));
    for (const budget of supplied) {
      const group = `${budget?.provider}/${budget?.model}`;
      if (!expected.delete(group)) throw invalid('Duplicate or unselected model budget group.');
    }
  }
  approved.model_budgets = approved.model_budgets.map((budget: Json) => {
    const previous = supplied?.find(
      (entry: Json) => entry.provider === budget.provider && entry.model === budget.model,
    );
    if (!previous) return budget;
    const pricing = previous.pricing;
    if (
      pricing !== undefined &&
      pricing !== null &&
      (!Number.isSafeInteger(pricing.input_microusd_per_million) ||
        pricing.input_microusd_per_million < 0 ||
        !Number.isSafeInteger(pricing.output_microusd_per_million) ||
        pricing.output_microusd_per_million < 0)
    )
      throw invalid('Budget pricing must contain nonnegative safe integer rates.');
    return {
      ...budget,
      max_requests: tighten(previous.max_requests, budget.max_requests, 1, true),
      max_output_tokens: tighten(previous.max_output_tokens, budget.max_output_tokens, 256),
      max_execution_ms: tighten(previous.max_execution_ms, budget.max_execution_ms, 60000),
      spend_limit_microusd: tighten(previous.spend_limit_microusd, limit, 1, true),
      pricing: {
        ...budget.pricing,
        input_microusd_per_million: Math.max(
          budget.pricing.input_microusd_per_million,
          pricing?.input_microusd_per_million ?? 0,
        ),
        output_microusd_per_million: Math.max(
          budget.pricing.output_microusd_per_million,
          pricing?.output_microusd_per_million ?? 0,
        ),
      },
    };
  });
  return approved;
}

const invalid = (message: string) => Object.assign(new Error(message), { code: 'INVALID_INPUT' });
function tighten(value: unknown, ceiling: number, minimum: number, nullable = false): number {
  if (value === undefined || (value === null && nullable)) return ceiling;
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    throw invalid('Model budget bounds must be valid safe integers.');
  return Math.min(Number(value), ceiling);
}
