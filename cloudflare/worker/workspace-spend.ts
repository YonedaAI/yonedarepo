import type { Json } from './types';

const fail = (message: string) =>
  Object.assign(new Error(message), { code: 'WORKSPACE_SPEND_SCOPE' });
const money = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;

export function validateWorkspaceSpendRun(run: Json) {
  const budgets = run.model_budgets;
  if (!Array.isArray(budgets) || budgets.length === 0)
    throw fail('Workspace inference requires priced approved model groups');
  const groups = new Set<string>();
  for (const budget of budgets) {
    const group = `${budget.provider}/${budget.model}`;
    if (
      typeof budget.provider !== 'string' ||
      typeof budget.model !== 'string' ||
      groups.has(group) ||
      !budget.pricing ||
      !money(budget.pricing.input_microusd_per_million) ||
      !money(budget.pricing.output_microusd_per_million) ||
      typeof budget.pricing.source !== 'string' ||
      !budget.pricing.source
    )
      throw fail('Every pooled model group requires unique frozen pricing');
    groups.add(group);
  }
}
