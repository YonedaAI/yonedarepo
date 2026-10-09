import { useState } from 'react';
import { modelCatalogUrl, modelOptions } from './providerModels';

const customModel = '__custom_model__';

export function ProviderModelPicker({
  provider,
  model,
  connections,
  disabled,
  onChange,
}: {
  provider: string;
  model: string;
  connections: { provider: string; model: string }[];
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  const [custom, setCustom] = useState(false);
  const options = modelOptions(provider, connections, model);
  const allowCustom = provider !== 'claude';
  const selected = custom
    ? customModel
    : options.some((option) => option.id === model)
      ? model
      : '';
  const url = modelCatalogUrl(provider);
  return (
    <div className="provider-model-picker">
      <label>
        Model
        <select
          value={selected}
          required
          disabled={disabled}
          onChange={(event) => {
            setCustom(event.target.value === customModel);
            onChange(event.target.value === customModel ? '' : event.target.value);
          }}
        >
          <option value="" disabled>
            Choose a model
          </option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
          {allowCustom && <option value={customModel}>Custom model…</option>}
        </select>
      </label>
      {custom && allowCustom && (
        <label>
          Custom model ID
          <input
            value={model}
            onChange={(event) => onChange(event.target.value)}
            required
            maxLength={128}
            pattern="[A-Za-z0-9._/-]+"
            disabled={disabled}
            placeholder="Exact model ID from your provider"
          />
        </label>
      )}
      <small className="provider-model-note">
        {provider === 'zai'
          ? 'This connector uses ZAI’s Anthropic-compatible endpoint. Check that your account supports the selected model.'
          : allowCustom
            ? 'Availability varies by account.'
            : 'This workspace permits Sonnet only.'}
        {provider === 'zai' && (
          <>
            {' '}
            <a href="https://docs.z.ai/devpack/latest-model" target="_blank" rel="noreferrer">
              Account model support
            </a>
            .
          </>
        )}
        {url && (
          <>
            {' '}
            <a href={url} target="_blank" rel="noreferrer">
              Model catalog
            </a>
          </>
        )}
      </small>
    </div>
  );
}
