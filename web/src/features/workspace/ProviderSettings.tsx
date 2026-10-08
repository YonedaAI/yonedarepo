import { Bot, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
export type Provider = { id: string; label: string; provider: string; model: string };
export const defaults: Record<string, string> = {
  mimo: 'mimo-v2.6-flash',
  zai: 'glm-4.7-flash',
  codex: 'gpt-5.6-luna',
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-3.8-flash',
};
export const providerNames: Record<string, string> = {
  mimo: 'MiMo',
  zai: 'ZAI',
  codex: 'OpenAI / Codex',
  claude: 'Anthropic / Claude',
  gemini: 'Google / Gemini',
};
export function ProviderSettings({ onClose }: { onClose: () => void }) {
  const [configured, setConfigured] = useState<Provider[]>([]);
  const [provider, setProvider] = useState('mimo');
  const [model, setModel] = useState(defaults.mimo);
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
                </small>
              </div>
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
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          setBusy(true);
          setError('');
          setMessage('');
          try {
            await api('settings/connections', {
              label: data.get('label'),
              key: data.get('key'),
              provider,
              model,
            });
            form.reset();
            await load();
            setMessage('Connection added. Choose it when creating a run.');
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h3>Add a connection</h3>
        <label>
          Connection name
          <input
            name="label"
            placeholder="Personal testing"
            required
            maxLength={80}
            disabled={busy}
          />
        </label>
        <label>
          Provider
          <select
            value={provider}
            disabled={busy}
            onChange={(e) => {
              setProvider(e.target.value);
              setModel(defaults[e.target.value]);
            }}
          >
            {Object.keys(defaults).map((p) => (
              <option key={p} value={p}>
                {providerNames[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            required
            maxLength={128}
            pattern="[A-Za-z0-9._/-]+"
            readOnly={provider === 'claude'}
            disabled={busy}
          />
        </label>
        <label>
          API key
          <input
            type="password"
            name="key"
            autoComplete="off"
            required
            minLength={8}
            maxLength={4096}
            disabled={busy}
          />
        </label>
        <p className="subtle">
          Hosted runs use your provider billing. Claude uses Sonnet with the existing $20 workspace
          allowance. Models are recorded with every run.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        <button type="submit" disabled={busy || loading}>
          <Plus size={16} />
          {busy ? 'Saving…' : 'Add connection'}
        </button>
      </form>
    </section>
  );
}
