import { type ModelOption, providerDefinition, providers } from '../../../../shared/providers';

export type { ModelOption } from '../../../../shared/providers';
export const defaults: Record<string, string> = Object.fromEntries(
  providers.map((provider) => [provider.id, provider.default_model]),
);
export const providerNames: Record<string, string> = Object.fromEntries(
  providers.map((provider) => [provider.id, provider.name]),
);

export function providerDisplayName(provider: string) {
  return (
    (
      { claude: 'Claude', codex: 'Codex', zai: 'ZAI', mimo: 'MiMo', gemini: 'Gemini' } as Record<
        string,
        string
      >
    )[provider] ??
    providerNames[provider] ??
    provider
  );
}

/** Model identity is visible; connection identity stays in the selected value. */
export function modelDisplayName(provider: string, model: string) {
  return (
    providers
      .find((entry) => entry.id === provider)
      ?.models.find((entry) => entry.id === model)
      ?.label.split(' · ')[0] ?? model
  );
}

export function modelReasoningEfforts(provider: string, model: string): readonly string[] {
  return (
    providers.find((entry) => entry.id === provider)?.models.find((entry) => entry.id === model)
      ?.reasoning_efforts ?? []
  );
}

export function modelIsRunnable(provider: string, model: string) {
  return !!providers
    .find((entry) => entry.id === provider)
    ?.models.find((entry) => entry.id === model)?.conservative_pricing;
}

export function reasoningLabel(effort: string) {
  return effort === 'xhigh' ? 'Extra high' : effort[0].toUpperCase() + effort.slice(1);
}

export function connectedModelGroups<T extends { id: string; provider: string; model: string }>(
  connections: T[],
  selectedConnection: string,
) {
  const choices = new Map<string, T>();
  for (const connection of connections) {
    if (
      !modelIsRunnable(connection.provider, connection.model) &&
      connection.id !== selectedConnection
    )
      continue;
    const key = JSON.stringify([connection.provider, connection.model]);
    if (!choices.has(key) || connection.id === selectedConnection) choices.set(key, connection);
  }
  const order = [
    ...new Set([
      ...providers.map((provider) => provider.id),
      ...connections.map((connection) => connection.provider),
    ]),
  ];
  return order.flatMap((provider) => {
    const options = [...choices.values()].filter((connection) => connection.provider === provider);
    return options.length
      ? [
          {
            provider,
            label: providerDisplayName(provider),
            options: options.map((connection) => ({
              connection,
              label: modelDisplayName(provider, connection.model),
              disabled: !modelIsRunnable(provider, connection.model),
            })),
          },
        ]
      : [];
  });
}

export function modelOptions(
  provider: string,
  connections: { provider: string; model: string }[],
  current: string,
) {
  const definition = providerDefinition(provider);
  const models: ModelOption[] = definition.models.map((model) => ({
    ...model,
    label: modelDisplayName(provider, model.id),
  }));
  if (!definition.allow_custom_model) return models;
  const known = new Set(models.map((model) => model.id));
  for (const connection of connections) {
    if (connection.provider !== provider || known.has(connection.model)) continue;
    known.add(connection.model);
    models.push({ id: connection.model, label: connection.model });
  }
  if (current && !known.has(current)) models.push({ id: current, label: current });
  return models;
}

export function modelCatalogUrl(provider: string) {
  return providerDefinition(provider).catalog_url;
}
