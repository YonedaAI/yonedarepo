import { useState } from 'react';
import { providerDefinition } from '../../../../shared/providers';
import { api } from '../../lib/api';
import type { Provider } from './ProviderSettings';
import { modelDisplayName } from './providerModels';

/** Reuse an encrypted saved key on explicit submission; no secret enters this form. */
export function AddProviderModel({
  source,
  connections,
  disabled,
  onSaved,
  onCancel,
}: {
  source: Provider;
  connections: Provider[];
  disabled: boolean;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const models = providerDefinition(source.provider).models.filter(
    (model) =>
      model.conservative_pricing &&
      !connections.some(
        (connection) => connection.provider === source.provider && connection.model === model.id,
      ),
  );
  const [model, setModel] = useState(models[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || disabled || !models.some((entry) => entry.id === model)) return;
        setBusy(true);
        setError('');
        try {
          await api(`settings/connections/${encodeURIComponent(source.id)}/models`, {
            model,
            expected_version: source.version ?? 0,
          });
          await onSaved();
        } catch (failure) {
          setError((failure as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Add a model</h3>
      <p className="subtle">Use the existing encrypted provider key.</p>
      <label>
        Model
        <select
          required
          value={model}
          disabled={disabled || busy || !models.length}
          onChange={(event) => setModel(event.target.value)}
        >
          {models.map((option) => (
            <option key={option.id} value={option.id}>
              {modelDisplayName(source.provider, option.id)}
            </option>
          ))}
        </select>
      </label>
      {!models.length && <p role="status">All available models are already connected.</p>}
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={disabled || busy || !model || !models.length}>
        {busy ? 'Adding…' : 'Add model'}
      </button>
      <button type="button" className="quiet" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
