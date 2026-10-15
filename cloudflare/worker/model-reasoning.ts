import { providerDefinition } from '../../shared/providers';
import type { Json } from './types';

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

function supportsEffort(provider: string, model: string, effort: string) {
  try {
    return !!providerDefinition(provider)
      .models.find((option) => option.id === model)
      ?.reasoning_efforts?.includes(effort);
  } catch {
    return false;
  }
}

/** Provider payloads cannot change the effort frozen by the authoritative execution. */
export function enforceFrozenReasoning(job: Json, body: Json, harness: string) {
  const execution = job.payload?.execution;
  const provider = execution?.provider ?? execution?.harness;
  // GLM's own default is maximum thinking, which made every turn take 5–20 s; an unchosen
  // effort runs low. Other providers keep their defaults when no effort was chosen.
  const effort =
    normalizeReasoningEffort(provider, job.model, execution?.reasoning_effort) ??
    (provider === 'zai' && supportsEffort(provider, job.model, 'low') ? 'low' : undefined);
  if (effort === undefined) return;
  delete body.reasoning_effort;
  if (harness === 'codex') {
    body.reasoning = {
      ...(body.reasoning && typeof body.reasoning === 'object' ? body.reasoning : {}),
      effort,
    };
    return;
  }
  if (harness !== 'claude') throw new Error('Reasoning effort adapter unavailable for this model');
  body.output_config = {
    ...(body.output_config && typeof body.output_config === 'object' ? body.output_config : {}),
    effort,
  };
  if (execution.provider === 'claude') {
    body.thinking = {
      type: 'adaptive',
      ...(body.thinking?.display
        ? { display: body.thinking.display === 'updates' ? 'summarized' : body.thinking.display }
        : {}),
    };
  } else if (execution.provider === 'zai') {
    body.thinking = { type: 'enabled' };
  } else {
    throw new Error('Reasoning effort adapter unavailable for this provider');
  }
}
