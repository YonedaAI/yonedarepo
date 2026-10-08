import type { Json } from './types';

/** Limits are the owner's immutable run approval, never values from a model request. */
export function approvedModelBudget(job: Json): Json | undefined {
  const budgets = job.payload?.run?.model_budgets;
  if (budgets === undefined) return undefined;
  const execution = job.payload?.execution;
  const budget = Array.isArray(budgets)
    ? budgets.find(
        (entry: Json) => entry.provider === execution?.provider && entry.model === job.model,
      )
    : undefined;
  if (!budget || !Number.isSafeInteger(budget.max_output_tokens))
    throw new Error('The approved model budget is missing or invalid');
  return budget;
}

export function outputCeiling(job: Json) {
  return approvedModelBudget(job)?.max_output_tokens ?? 4096;
}

export function requestUsage(body: Json, harness: string) {
  const output =
    harness === 'codex'
      ? body.max_output_tokens
      : harness === 'gemini'
        ? body.generationConfig?.maxOutputTokens
        : body.max_tokens;
  return {
    input_bytes: output === undefined ? 0 : new TextEncoder().encode(JSON.stringify(body)).length,
    output_tokens: output ?? 0,
  };
}
