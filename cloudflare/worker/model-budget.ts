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

/**
 * The ledger may grant a smaller response than requested so the request fits the real remaining
 * allowance instead of being refused. Lower the provider-enforced output cap to that grant; never
 * raise it. Claude manual thinking must stay strictly below max_tokens.
 */
export function grantOutputAllowance(
  body: Json,
  harness: 'codex' | 'claude' | 'gemini',
  granted: number,
): Json {
  if (!Number.isSafeInteger(granted) || granted < 1) return body;
  if (harness === 'codex') {
    if (body.max_output_tokens === undefined || body.max_output_tokens > granted)
      body.max_output_tokens = granted;
  } else if (harness === 'gemini') {
    body.generationConfig = body.generationConfig ?? {};
    const current = body.generationConfig.maxOutputTokens;
    if (current === undefined || current > granted) body.generationConfig.maxOutputTokens = granted;
  } else {
    if (body.max_tokens === undefined || body.max_tokens > granted) body.max_tokens = granted;
    const thinking = body.thinking;
    if (thinking?.type === 'enabled' && thinking.budget_tokens >= body.max_tokens)
      body.thinking =
        body.max_tokens > 1024
          ? { ...thinking, budget_tokens: body.max_tokens - 1 }
          : { type: 'disabled' };
  }
  return body;
}
