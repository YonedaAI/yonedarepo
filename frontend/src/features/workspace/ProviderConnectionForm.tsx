import { Plus, Save } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { ProviderBillingPicker } from './ProviderBillingPicker';
import { ProviderModelPicker } from './ProviderModelPicker';
import type { Provider } from './ProviderSettings';
import { defaults, providerNames } from './providerModels';

export function ProviderConnectionForm({
  editing,
  connections,
  disabled,
  onCancel,
  onSaved,
}: {
  editing: Provider | null;
  connections: Provider[];
  disabled: boolean;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [provider, setProvider] = useState(editing?.provider ?? 'mimo');
  const [model, setModel] = useState(editing?.model ?? defaults.mimo);
  const [plan, setPlan] = useState<string>(editing?.routing?.plan ?? 'api_credits');
  const [region, setRegion] = useState(
    editing?.routing?.plan === 'token_plan' ? editing.routing.region : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = disabled || busy;
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        setBusy(true);
        setError('');
        try {
          await api(
            editing
              ? `settings/connections/${encodeURIComponent(editing.id)}`
              : 'settings/connections',
            {
              label: data.get('label'),
              key: data.get('key'),
              provider,
              model,
              ...(editing ? { expected_version: editing.version ?? 0 } : {}),
              ...(provider === 'mimo'
                ? { routing: { plan, ...(plan === 'token_plan' ? { region } : {}) } }
                : {}),
            },
          );
          form.reset();
          await onSaved();
        } catch (failure) {
          setError((failure as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>{editing ? `Edit ${editing.label}` : 'Add a connection'}</h3>
      <label>
        Connection name
        <input
          name="label"
          defaultValue={editing?.label ?? ''}
          placeholder="Personal testing"
          required
          maxLength={80}
          disabled={locked}
        />
      </label>
      <label>
        Provider
        <select
          value={provider}
          disabled={locked || !!editing}
          onChange={(event) => {
            setProvider(event.target.value);
            setModel(defaults[event.target.value]);
            setPlan('api_credits');
            setRegion('');
          }}
        >
          {Object.keys(defaults).map((id) => (
            <option key={id} value={id}>
              {providerNames[id]}
            </option>
          ))}
        </select>
      </label>
      <ProviderModelPicker
        key={provider}
        provider={provider}
        model={model}
        connections={connections}
        disabled={locked}
        onChange={setModel}
      />
      {provider === 'mimo' && (
        <ProviderBillingPicker
          plan={plan}
          region={region}
          disabled={locked}
          onPlan={setPlan}
          onRegion={setRegion}
        />
      )}
      <label>
        {editing ? 'Replace API key (optional)' : 'API key'}
        <input
          type="password"
          key={provider}
          name="key"
          autoComplete="off"
          required={!editing}
          minLength={8}
          maxLength={4096}
          placeholder={editing ? 'Leave blank to keep the stored key' : ''}
          disabled={locked}
          onChange={(event) => {
            if (provider === 'mimo' && /^(tp-|ttp-)/.test(event.target.value))
              setPlan('token_plan');
          }}
        />
      </label>
      <p className="subtle">
        {editing
          ? 'The stored key stays encrypted. Changes apply to new runs; existing approvals keep their original settings.'
          : 'Hosted runs use your provider billing. Claude uses Sonnet with the existing $20 workspace allowance. Models are recorded with every run.'}
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button type="submit" disabled={locked}>
        {editing ? <Save size={16} /> : <Plus size={16} />}
        {busy ? 'Saving…' : editing ? 'Save connection' : 'Add connection'}
      </button>
      {editing && (
        <button type="button" className="quiet" disabled={locked} onClick={onCancel}>
          Cancel editing
        </button>
      )}
    </form>
  );
}
