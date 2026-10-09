import { Bot, Pencil, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { billingLabel, type ProviderRouting } from './ProviderBillingPicker';
import { ProviderConnectionForm } from './ProviderConnectionForm';
import { providerNames } from './providerModels';

export type Provider = {
  id: string;
  label: string;
  provider: string;
  model: string;
  routing?: ProviderRouting | null;
  version?: number;
};
export function ProviderSettings({ onClose }: { onClose: () => void }) {
  const [configured, setConfigured] = useState<Provider[]>([]);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const value = await api<{ providers: Provider[] }>('settings');
    setConfigured(value.providers);
  }, []);
  useEffect(() => {
    void load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [load]);
  return (
    <section className="workspace-panel">
      <div className="panel-heading">
        <h2>Agent providers</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p>
        Connect keys for hosted agents. Add multiple connections for the same provider, then choose
        a connection for each approach. Stored keys are encrypted and never returned to the browser.
      </p>
      {loading ? (
        <p role="status">Loading connections…</p>
      ) : configured.length ? (
        <ul className="provider-list">
          {configured.map((p) => (
            <li key={p.id}>
              <Bot size={19} />
              <div>
                <strong>{p.label}</strong>
                <small>
                  {providerNames[p.provider]} · <code>{p.model}</code>
                  {p.provider === 'mimo' && <> · {billingLabel(p.routing)}</>}
                  {p.provider === 'zai' && ' · Coding Plan'}
                </small>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={`Edit connection ${p.label}`}
                disabled={busy}
                onClick={() => {
                  setEditing(p);
                  setMessage('');
                }}
              >
                <Pencil size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove connection ${p.label}`}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  setMessage('');
                  try {
                    const r = await fetch(`/api/settings/connections/${encodeURIComponent(p.id)}`, {
                      method: 'DELETE',
                    });
                    if (!r.ok) throw new Error('Could not remove connection');
                    if (editing?.id === p.id) setEditing(null);
                    await load();
                    setMessage(
                      'Connection removed. Existing runs using it can no longer make model calls.',
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="inline-empty">No connections yet. Add a key below to start hosted agents.</p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <ProviderConnectionForm
        key={editing?.id ?? 'new'}
        editing={editing}
        connections={configured}
        disabled={busy || loading}
        onCancel={() => setEditing(null)}
        onSaved={async () => {
          await load();
          setEditing(null);
          setMessage('Connection saved. Restart a finished run to use the updated settings.');
        }}
      />
    </section>
  );
}
