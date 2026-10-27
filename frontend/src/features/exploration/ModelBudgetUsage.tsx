import { providerNames } from '../workspace/providerModels';
import { agentTimeRule, formatBudgetUsd, type ModelBudget } from './modelBudgets';

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

/** Tokens a sandbox run's responses reported (`metered_usage`), input including cache. */
function meteredTokens(usage: Record<string, unknown> | undefined) {
  const n = (key: string) => (Number.isSafeInteger(usage?.[key]) ? Number(usage?.[key]) : 0);
  if (!usage) return null;
  const input = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
  return `${input.toLocaleString()} in / ${n('output_tokens').toLocaleString()} out`;
}

export function ModelBudgetUsage({ run }: { run: Record<string, any> }) {
  // A sandbox run's spend is metered from each model response's own usage report.
  const metered = run.runtime === 'sandbox-cli-v1';
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
      {metered ? (
        <p>
          Spend is metered from the usage each model response reports, at the approved rates. A new
          model request is refused only once an allowance is spent. Provider invoices can differ.
        </p>
      ) : (
        <p>
          Shared across all connections, agents and retries using the same provider and model.
          Estimates settle when complete usage is available; pending or unknown usage keeps its
          reservation. Requests include retries and provider rejections. Provider invoices can
          differ.
        </p>
      )}
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
                <dt>{metered ? 'Spend (metered)' : 'Allowance used (estimate)'}</dt>
                <dd>
                  {budget.pricing ? formatBudgetUsd(budget.charged_microusd) : 'Not priced'}
                  {budget.spend_limit_microusd != null &&
                    ` / ${formatBudgetUsd(budget.spend_limit_microusd)}`}
                </dd>
              </div>
              {metered && (
                <div>
                  <dt>Tokens</dt>
                  <dd>
                    {meteredTokens(run.metered_usage?.[`${budget.provider}/${budget.model}`]) ??
                      'None yet'}
                  </dd>
                </div>
              )}
              <div>
                <dt>Time per attempt</dt>
                <dd>{agentTimeRule(budget.idle_timeout_ms)}</dd>
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
      {!metered && (
        <p>
          Each request must fit its worst-case reservation into the remaining allowance. Work can
          stop before the displayed estimate reaches the limit.
        </p>
      )}
    </section>
  );
}
