import { providerNames } from '../workspace/providerModels';
import { formatBudgetUsd, type ModelBudget } from './modelBudgets';

function recordedBudget(value: unknown): value is ModelBudget {
  if (typeof value !== 'object' || value === null) return false;
  const budget = value as Partial<ModelBudget>;
  return typeof budget.provider === 'string' && typeof budget.model === 'string';
}

function count(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString()
    : '—';
}

export function ModelBudgetUsage({ run }: { run: Record<string, any> }) {
  const budgets = Array.isArray(run.model_budgets) ? run.model_budgets.filter(recordedBudget) : [];
  if (!budgets.length) {
    return (
      <details className="model-budget-usage legacy-budget">
        <summary>Model budgets · legacy limits</summary>
        <p>
          Per-model allowances were not recorded for this run. Its existing operator, harness and
          local-client limits apply.
        </p>
      </details>
    );
  }
  return (
    <section className="model-budget-usage" aria-labelledby="model-budget-usage-heading">
      <h2 id="model-budget-usage-heading">Model allowances and usage</h2>
      <p>
        Shared across all connections, root agents, subagents and retries using the same provider
        and model. Estimates settle when complete usage is available; pending or unknown usage keeps
        its reservation. Requests include retries and provider rejections. Provider invoices can
        differ.
      </p>
      <div className="budget-usage-grid">
        {budgets.map((budget: ModelBudget) => (
          <article className="budget-usage-card" key={`${budget.provider}:${budget.model}`}>
            <h3>{providerNames[budget.provider] ?? budget.provider}</h3>
            <code className="model-name">{budget.model}</code>
            <dl>
              <div>
                <dt>Model requests</dt>
                <dd>
                  {count(budget.requests)}
                  {budget.max_requests == null
                    ? ' · No request cap'
                    : ` / ${count(budget.max_requests)}`}
                </dd>
              </div>
              <div>
                <dt>Allowance used (estimate)</dt>
                <dd>
                  {budget.pricing ? formatBudgetUsd(budget.charged_microusd) : 'Not priced'}
                  {budget.spend_limit_microusd != null &&
                    ` / ${formatBudgetUsd(budget.spend_limit_microusd)}`}
                </dd>
              </div>
              <div>
                <dt>Time per execution</dt>
                <dd>
                  {typeof budget.max_execution_ms === 'number'
                    ? `${(budget.max_execution_ms / 60_000).toLocaleString(undefined, { maximumFractionDigits: 3 })} min`
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>Output per response</dt>
                <dd>{count(budget.max_output_tokens)} tokens</dd>
              </div>
            </dl>
            {budget.pricing && (
              <p className="budget-rates-source">
                {formatBudgetUsd(budget.pricing.input_microusd_per_million)} input /{' '}
                {formatBudgetUsd(budget.pricing.output_microusd_per_million)} output per 1M tokens
                <br />
                {budget.pricing.source === 'owner-approved conservative rates'
                  ? 'Approved budget rates · provider bill may differ'
                  : 'Pricing source unavailable'}
              </p>
            )}
          </article>
        ))}
      </div>
      <p>
        Each request must fit its worst-case reservation into the remaining allowance. Work can stop
        before the displayed estimate reaches the limit.
      </p>
    </section>
  );
}
