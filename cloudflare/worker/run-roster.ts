import {
  type ProviderDefinition,
  providerDefinition,
  runsInSandbox,
  sandboxCliFits,
  sandboxCliNames,
} from '../../shared/providers';
import { normalizeReasoningEffort } from './model-reasoning';
import type { Json } from './types';

const roles = new Set(['auto', 'builder', 'frontend', 'backend', 'design', 'testing', 'review']);
const invalid = (message: string) => Object.assign(new Error(message), { code: 'INVALID_INPUT' });

/**
 * The run's roster from the browser's agent preferences (`adaptive_team.requested_agents`):
 * saved connections and the public pricing catalog define the pool, never browser fields. A
 * team run takes its owner-written task list; automatic planning was retired.
 */
export function resolveRunRoster(
  input: Json,
  connections: Json[],
  workspaceLimit = 50000000,
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
  const coordinated = input.mode === 'collaborate';
  if (coordinated && input.team == null)
    throw Object.assign(new Error('Team runs take an owner-written task list.'), {
      code: 'NOT_SUPPORTED',
    });
  if (requested.model_mix !== undefined)
    throw Object.assign(new Error('Model mixes were retired with automatic teams.'), {
      code: 'NOT_SUPPORTED',
    });
  const explicitConnections = new Set(
    requested.requested_agents
      .map((agent: Json) => agent.connection)
      .filter((id: unknown) => typeof id === 'string'),
  );
  // Every run starts a coding CLI per agent in a sandbox: Auto picks only models one can run,
  // and a chosen model none can run is refused before the run starts.
  const pool = connections.flatMap((connection) => {
    let definition: ProviderDefinition;
    try {
      definition = providerDefinition(connection.provider);
    } catch {
      return [];
    }
    if (!runsInSandbox(definition.id)) {
      if (explicitConnections.has(connection.id))
        throw Object.assign(new Error(`No sandbox CLI runs ${definition.name} models.`), {
          code: 'SANDBOX_HARNESS',
        });
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
  // An unchosen connection takes the cheapest auto-eligible priced model.
  const automaticChoice = () =>
    pool.find((member) =>
      providerDefinition(member.provider).models.some(
        (model) => model.id === member.model && model.auto_seed_eligible === true,
      ),
    );
  const agents = requested.requested_agents.map((preference: Json, index: number) => {
    const selected =
      preference.connection === null
        ? automaticChoice()
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
    // A sandbox agent's stock CLI; unchosen, the ledger freezes the provider's default.
    const cli = preference.cli ?? undefined;
    if (cli !== undefined && !sandboxCliFits(selected.provider, cli))
      throw Object.assign(
        new Error(
          `${sandboxCliNames[cli as keyof typeof sandboxCliNames] ?? 'That CLI'} cannot run ${providerDefinition(selected.provider).name} models.`,
        ),
        { code: 'SANDBOX_HARNESS' },
      );
    return {
      ...agentIdentity,
      ...(effort === undefined ? {} : { reasoning_effort: effort }),
      ...(cli === undefined ? {} : { cli }),
      role_hint: preference.role,
      strategy: `${preference.role} ${input.mode === 'compare' ? 'approach' : 'team participant'} ${index + 1}`,
    };
  });
  const budgets = new Map<string, Json>();
  for (const model of pool) {
    if (
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
  const { adaptive_team: _preferences, ...request } = input;
  return {
    ...request,
    mode: coordinated ? 'collaborate' : 'compare',
    _workspace_spend: true,
    agents,
    model_budgets: [...budgets.values()],
    delegation: coordinated
      ? { enabled: false, max_depth: 0, max_executions: agents.length }
      : input.delegation,
  };
}
