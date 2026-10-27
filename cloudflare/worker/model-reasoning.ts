import { providerDefinition } from '../../shared/providers';

/** Auto stays absent; explicit effort must be supported by the exact catalog model. */
export function normalizeReasoningEffort(
  provider: string,
  model: string,
  value: unknown,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const option = providerDefinition(provider).models.find((option) => option.id === model);
  if (typeof value !== 'string' || !option?.reasoning_efforts?.includes(value))
    throw Object.assign(new Error('Reasoning effort is unsupported for the selected model'), {
      code: 'INVALID_INPUT',
    });
  return value;
}
