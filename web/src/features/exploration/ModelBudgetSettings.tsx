import { useState } from 'react';
import { providerNames } from '../workspace/providerModels';
import {
  defaultModelBudget,
  editDollarBudget,
  editModelPricing,
  type ModelBudgetDraft,
  modelPricingSuggestion,
  type SelectedModel,
} from './modelBudgets';
import { WorkspaceAllowance } from './WorkspaceAllowance';

function ModelAllowance({
  model,
  value,
  locked,
  onChange,
}: {
  model: SelectedModel;
  value: ModelBudgetDraft;
  locked: boolean;
  onChange: (value: ModelBudgetDraft) => void;
}) {
  const pricing = modelPricingSuggestion(model.provider, model.model);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const missingRates = value.usdEnabled && (!value.inputRate || !value.outputRate);
  function change(patch: Partial<ModelBudgetDraft>) {
    onChange({ ...value, ...patch });
  }
  return (
    <fieldset className="model-allowance" disabled={locked}>
      <legend>{providerNames[model.provider] ?? model.provider}</legend>
      <code className="model-name">{model.model}</code>
      <div className="budget-controls budget-main-controls">
        <label>
          Minutes per execution
          <input
            type="number"
            min={1}
            max={30}
            step="any"
            required
            value={value.minutes}
            onChange={(event) => change({ minutes: event.target.value })}
          />
        </label>
        <label className="model-request-label">
          Request limit (optional)
          <input
            type="number"
            min={1}
            step={1}
            value={value.requests}
            placeholder="No request cap"
            onChange={(event) => change({ requests: event.target.value })}
          />
        </label>
        <label className="model-dollar-label">
          Estimated budget (USD, optional)
          <span className="model-dollar-input">
            <span aria-hidden="true">$</span>
            <input
              type="number"
              min="0.000001"
              step="any"
              value={value.usd}
              placeholder="No dollar cap"
              onChange={(event) => {
                const next = editDollarBudget(model, value, event.target.value);
                onChange(next);
                if (next.usdEnabled && (!next.inputRate || !next.outputRate)) setAdvancedOpen(true);
              }}
            />
          </span>
        </label>
      </div>
      <p className="subtle">
        One request is one model call. Blank means no YonedaRepo request cap; provider quotas still
        apply.
      </p>
      {value.usdEnabled && (
        <p className={missingRates ? 'budget-rate-guidance' : 'subtle'}>
          {missingRates
            ? 'Add this model’s rates in Advanced limits to use a dollar budget.'
            : 'Uses conservative estimates approved with your run brief.'}
        </p>
      )}
      <details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary>Advanced limits</summary>
        <div className="budget-advanced-content">
          <div className="budget-controls">
            <label>
              Output tokens per response
              <input
                type="number"
                min={256}
                max={4096}
                step={1}
                required
                value={value.outputTokens}
                onChange={(event) => change({ outputTokens: event.target.value })}
              />
            </label>
          </div>
          <div className="budget-pricing">
            <div className="budget-controls budget-rate-controls">
              <label>
                Input USD per 1M tokens
                <input
                  type="number"
                  min={0}
                  step="0.000001"
                  required={value.usdEnabled}
                  value={value.inputRate}
                  onChange={(event) =>
                    onChange(editModelPricing(value, 'inputRate', event.target.value))
                  }
                />
              </label>
              <label>
                Output USD per 1M tokens
                <input
                  type="number"
                  min={0}
                  step="0.000001"
                  required={value.usdEnabled}
                  value={value.outputRate}
                  onChange={(event) =>
                    onChange(editModelPricing(value, 'outputRate', event.target.value))
                  }
                />
              </label>
            </div>
            <p className="subtle">
              {pricing?.note ??
                'Enter conservative rates from your provider’s current pricing. Your run brief approval includes these rates.'}
              {pricing && (
                <>
                  {' '}
                  <a href={pricing.url} target="_blank" rel="noreferrer">
                    Official pricing
                  </a>{' '}
                  (checked October 8, 2026).
                </>
              )}
            </p>
            <p className="subtle">
              Estimates differ from provider invoices. Each request reserves its worst-case cost, so
              work can stop before the displayed estimate reaches the budget.
            </p>
          </div>
        </div>
      </details>
    </fieldset>
  );
}

export function ModelBudgetSettings({
  supported,
  models,
  drafts,
  locked,
  onChange,
}: {
  supported: boolean;
  models: SelectedModel[];
  drafts: Record<string, ModelBudgetDraft>;
  locked: boolean;
  onChange: (key: string, value: ModelBudgetDraft) => void;
}) {
  return (
    <section className="model-budget-settings" aria-labelledby="model-budget-heading">
      <h3 id="model-budget-heading">Model budgets</h3>
      {!supported ? (
        <p className="inline-empty">
          Per-model budgets are unavailable on this deployment. Existing limits apply.
        </p>
      ) : (
        <>
          <p className="subtle">
            Request and dollar caps are optional and off by default. Any limits you set are shared
            by agents, subagents and retries using the same model. Execution time and response size
            remain bounded.
          </p>
          {!models.length && <p>Select a provider connection above to configure its budget.</p>}
          {models.map((model) => (
            <ModelAllowance
              key={model.key}
              model={model}
              value={drafts[model.key] ?? defaultModelBudget(model)}
              locked={locked}
              onChange={(value) => onChange(model.key, value)}
            />
          ))}
        </>
      )}
      {models.some((model) => model.provider === 'claude') && <WorkspaceAllowance />}
    </section>
  );
}
