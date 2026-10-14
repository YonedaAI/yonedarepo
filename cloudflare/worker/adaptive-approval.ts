import { type ProviderDefinition, providerDefinition } from '../../shared/providers';
import { ownsTask, parseModelMix, resolveModelMix } from './model-mix';
import { normalizeReasoningEffort } from './model-reasoning';
import type { Json } from './types';

const roles = new Set(['auto', 'builder', 'frontend', 'backend', 'design', 'testing', 'review']);
const invalid = (message: string) => Object.assign(new Error(message), { code: 'INVALID_INPUT' });

/** Saved connections and the public pricing catalog define the pool, never browser fields. */
export function resolveAdaptiveApproval(
  input: Json,
  connections: Json[],
  workspaceLimit = 50000000,
  allowAdaptive = true,
): Json {
  if (!Number.isSafeInteger(workspaceLimit) || workspaceLimit <= 0)
    throw invalid('The workspace allowance is unavailable.');
  const requested = input.adaptive_team;
  if (
    requested?.version !== 1 ||
    !Array.isArray(requested.requested_agents) ||
    requested.requested_agents.length < 1 ||
    requested.requested_agents.length > 6 ||
    requested.requested_agents.some(
      (agent: Json) =>
        !agent ||
        !roles.has(agent.role) ||
        !(agent.connection === null || typeof agent.connection === 'string'),
    )
  )
    throw invalid('Choose between one and six agent preferences with valid roles.');
  const coordinated = input.mode !== 'compare';
  const automatic = allowAdaptive && coordinated && input.team == null;
  const mix = parseModelMix(requested.model_mix);
  if (mix && !coordinated) throw invalid('A model mix requires a coordinated team run.');
  const explicitConnections = new Set(
    requested.requested_agents
      .map((agent: Json) => agent.connection)
      .filter((id: unknown) => typeof id === 'string'),
  );
  const automaticConnections = new Set<string>();
  const pool = connections.flatMap((connection) => {
    let definition: ProviderDefinition;
    try {
      definition = providerDefinition(connection.provider);
    } catch {
      return [];
    }
    const model = definition.models.find((model) => model.id === connection.model);
    if (
      typeof connection.id !== 'string' ||
      !connection.id ||
      !model?.conservative_pricing ||
      (model.auto_seed_eligible !== true && !explicitConnections.has(connection.id)) ||
      (connection.version !== undefined && !Number.isSafeInteger(connection.version))
    )
      return [];
    if (model.auto_seed_eligible === true) automaticConnections.add(connection.id);
    return [
      {
        connection: connection.id,
        provider: connection.provider,
        model: model.id,
        ...(model.reasoning_efforts?.length
          ? { reasoning_efforts: [...model.reasoning_efforts] }
          : {}),
        ...(connection.version === undefined ? {} : { version: connection.version }),
        ...(connection.routing == null ? {} : { routing: connection.routing }),
        pricing: model.conservative_pricing,
      },
    ];
  });
  pool.sort(
    (a, b) =>
      a.pricing.input_microusd_per_million +
        a.pricing.output_microusd_per_million -
        b.pricing.input_microusd_per_million -
        b.pricing.output_microusd_per_million || a.connection.localeCompare(b.connection),
  );
  if (!pool.length)
    throw Object.assign(new Error('Connect a model with verified pricing before starting.'), {
      code: 'PROVIDER_MISSING',
    });
  const mixed = mix && resolveModelMix(mix, pool);
  const automaticChoice = (index: number) =>
    mixed
      ? !automatic && ownsTask(input.team, index)
        ? mixed.specialists
        : mixed.coordination
      : pool.find((member) => automaticConnections.has(member.connection));
  const agents = requested.requested_agents.map((preference: Json, index: number) => {
    const selected =
      preference.connection === null
        ? automaticChoice(index)
        : pool.find((model) => model.connection === preference.connection);
    if (!selected)
      throw invalid('A selected model connection is missing or has no verified pricing.');
    const { pricing: _pricing, ...identity } = selected;
    const { reasoning_efforts: _supportedEfforts, ...agentIdentity } = identity;
    const effort = normalizeReasoningEffort(
      selected.provider,
      selected.model,
      preference.reasoning_effort,
    );
    return {
      ...agentIdentity,
      ...(effort === undefined ? {} : { reasoning_effort: effort }),
      role_hint: preference.role,
      strategy: `${preference.role} ${input.mode === 'compare' ? 'approach' : 'team participant'} ${index + 1}`,
    };
  });
  const budgets = new Map<string, Json>();
  for (const model of pool) {
    if (
      !automatic &&
      !agents.some(
        (agent: Json) => agent.provider === model.provider && agent.model === model.model,
      )
    )
      continue;
    budgets.set(`${model.provider}/${model.model}`, {
      provider: model.provider,
      model: model.model,
      max_requests: 144,
      max_output_tokens: 4096,
      max_execution_ms: 600000,
      spend_limit_microusd: workspaceLimit,
      pricing: model.pricing,
    });
  }
  return {
    ...input,
    mode: coordinated ? 'collaborate' : 'compare',
    ...(automatic ? { team: null } : {}),
    adaptive_team: automatic
      ? {
          version: 1,
          requested_agents: requested.requested_agents.map((agent: Json, index: number) => ({
            connection: agent.connection,
            role: agent.role,
            ...(agents[index].reasoning_effort === undefined
              ? {}
              : { reasoning_effort: agents[index].reasoning_effort }),
          })),
          ...(mixed ? { specialist_connection: mixed.specialists.connection } : {}),
        }
      : undefined,
    _approved_model_pool: automatic
      ? pool.map(({ pricing: _pricing, ...identity }) => identity)
      : undefined,
    _workspace_spend: true,
    agents: automatic ? [agents[0]] : agents,
    model_budgets: [...budgets.values()],
    delegation: coordinated
      ? { enabled: false, max_depth: 0, max_executions: agents.length }
      : input.delegation,
    autonomy_policy: coordinated
      ? {
          version: 1,
          enabled: true,
          max_repair_rounds: 2,
          max_concurrent_agents: 3,
          max_executions: 20,
          source_scope: 'project',
          allow_intent_questions: true,
        }
      : undefined,
  };
}
