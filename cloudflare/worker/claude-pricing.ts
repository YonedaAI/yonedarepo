/** Budget accounting ceilings, not provider invoices. USD per million tokens.
 * Input covers one-hour cache creation; output is bounded by max_tokens.
 * Legacy approvals retain their original conservative rates.
 */
export function claudeBudgetRates(model: string) {
  if (model === 'claude-sonnet-5-5') return { input: 4, output: 10 };
  if (model === 'claude-sonnet-4-6') return { input: 6, output: 30 };
  throw new Error('Claude budget pricing is unavailable for the approved model');
}
