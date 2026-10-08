import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
export type Provider = { provider: string; model: string };
export const defaults: Record<string, string> = {
  mimo: 'mimo-v2.6-flash',
  zai: 'glm-4.7-flash',
  codex: 'gpt-5.6-luna',
  claude: 'claude-sonnet-4-6',
};
export function ProviderSettings({ onClose }: { onClose: () => void }) {
  const [configured, setConfigured] = useState<Provider[]>([]);
  const [provider, setProvider] = useState('mimo');
  const [model, setModel] = useState(defaults.mimo);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    const value = await api<{ providers: Provider[] }>('settings');
    setConfigured(value.providers);
  }, []);
  useEffect(() => {
    void load().catch((e) => setMessage(e.message));
  }, [load]);
  return (
    <section className="workspace-panel">
      <div className="panel-heading">
        <h2>Agent providers</h2>
        <button type="button" className="quiet" onClick={onClose}>
          Close
        </button>
      </div>
      <p>
        Connect your API keys to run hosted agents. Keys are encrypted on the server and are used
        only by scoped inference requests. MiMo and ZAI are the low cost test choices. Claude has a
        shared $20 allowance in this workspace.
      </p>
      <ul>
        {configured.map((p) => (
          <li key={p.provider}>
            {p.provider}: <code>{p.model}</code> — connected{' '}
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await fetch(`/api/settings/providers/${p.provider}`, {
                    method: 'DELETE',
                  });
                  if (!r.ok) throw new Error('Could not remove key');
                  await load();
                } catch (e) {
                  setMessage((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove key
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const key = new FormData(form).get('key');
          setBusy(true);
          setMessage('');
          try {
            await api(`settings/providers/${provider}`, { key, model });
            form.reset();
            await load();
            setMessage('Provider connected.');
          } catch (e) {
            setMessage((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Provider
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setModel(defaults[e.target.value]);
            }}
          >
            {Object.keys(defaults).map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          Model
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            required
            readOnly={provider === 'claude'}
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
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Connect provider'}
        </button>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
