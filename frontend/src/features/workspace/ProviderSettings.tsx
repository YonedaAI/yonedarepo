import { Plus, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { AddProviderModel } from './AddProviderModel';
import type { ProviderRouting } from './ProviderBillingPicker';
import { ProviderConnectionForm } from './ProviderConnectionForm';
import { ProviderGroupList } from './ProviderGroupList';
import { billingRoute, groupConnections } from './providerGroups';

export type Provider = {
  id: string;
  label: string;
  provider: string;
  model: string;
  routing?: ProviderRouting | null;
  version?: number;
  alias_source?: { connection: string; version: number } | null;
};
export function ProviderSettings({ onClose }: { onClose: () => void }) {
  const [configured, setConfigured] = useState<Provider[]>([]);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [addingModel, setAddingModel] = useState<Provider | null>(null);
  const [adding, setAdding] = useState(false);
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
  async function remove(connection: Provider) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const r = await fetch(`/api/settings/connections/${encodeURIComponent(connection.id)}`, {
        method: 'DELETE',
      });
      if (!r.ok) throw new Error('Could not remove connection');
      if (editing?.id === connection.id) setEditing(null);
      await load();
      setMessage('Connection removed. Existing runs using it can no longer make model calls.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const groupKey = (connection: Provider) => `${connection.provider}:${billingRoute(connection)}`;
  return (
    <section className="workspace-panel provider-settings">
      <div className="panel-heading">
        <h2>Agent providers</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="subtle">
        Hosted agents use these models. YonedaRepo picks from them, or you choose one per run.
      </p>
      <button
        type="button"
        className="quiet provider-new-toggle"
        aria-expanded={adding}
        aria-controls="provider-new-connection"
        disabled={loading}
        onClick={() => {
          setAdding((open) => !open);
          setEditing(null);
          setAddingModel(null);
          setMessage('');
        }}
      >
        {adding ? <X size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
        Add a connection
      </button>
      {adding && (
        <div id="provider-new-connection" className="provider-new">
          <ProviderConnectionForm
            key="new"
            editing={null}
            connections={configured}
            disabled={busy || loading}
            onCancel={() => setAdding(false)}
            onSaved={async () => {
              await load();
              setAdding(false);
              setMessage('Connection saved. It is available when starting a run.');
            }}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {loading ? (
        <p role="status">Loading connections…</p>
      ) : configured.length ? (
        <ProviderGroupList
          groups={groupConnections(configured)}
          busy={busy}
          onAddModel={(source) => {
            setAddingModel(source);
            setEditing(null);
            setAdding(false);
            setMessage('');
          }}
          onEdit={(connection) => {
            setEditing(connection);
            setAddingModel(null);
            setAdding(false);
            setMessage('');
          }}
          onDelete={(connection) => void remove(connection)}
          slot={(group) =>
            addingModel && groupKey(addingModel) === group.key ? (
              <div className="provider-inline-form">
                <AddProviderModel
                  key={addingModel.id}
                  source={addingModel}
                  connections={configured}
                  disabled={busy || loading}
                  onCancel={() => setAddingModel(null)}
                  onSaved={async () => {
                    await load();
                    setAddingModel(null);
                    setMessage('Model connected. It is available when starting a run.');
                  }}
                />
              </div>
            ) : editing && groupKey(editing) === group.key ? (
              <div className="provider-inline-form">
                <ProviderConnectionForm
                  key={editing.id}
                  editing={editing}
                  connections={configured}
                  disabled={busy || loading}
                  onCancel={() => setEditing(null)}
                  onSaved={async () => {
                    await load();
                    setEditing(null);
                    setMessage(
                      'Connection saved. Restart a finished run to use the updated settings.',
                    );
                  }}
                />
              </div>
            ) : null
          }
        />
      ) : (
        <p className="inline-empty">No connections yet. Add one to start hosted agents.</p>
      )}
    </section>
  );
}
