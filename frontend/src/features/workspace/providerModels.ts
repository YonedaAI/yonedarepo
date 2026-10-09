import { type ModelOption, providerDefinition, providers } from '../../../../shared/providers';

export type { ModelOption } from '../../../../shared/providers';
export const defaults: Record<string, string> = Object.fromEntries(
  providers.map((provider) => [provider.id, provider.default_model]),
);
export const providerNames: Record<string, string> = Object.fromEntries(
  providers.map((provider) => [provider.id, provider.name]),
);

export function modelOptions(
  provider: string,
  connections: { provider: string; model: string }[],
  current: string,
) {
  const definition = providerDefinition(provider);
  const models: ModelOption[] = [...definition.models];
  if (!definition.allow_custom_model) return models;
  const known = new Set(models.map((model) => model.id));
  for (const connection of connections) {
    if (connection.provider !== provider || known.has(connection.model)) continue;
    known.add(connection.model);
    models.push({ id: connection.model, label: `${connection.model} · Saved model` });
  }
  if (current && !known.has(current))
    models.push({ id: current, label: `${current} · Current model` });
  return models;
}

export function modelCatalogUrl(provider: string) {
  return providerDefinition(provider).catalog_url;
}
