import { useState } from 'react';
import { connectOwner, disconnectOwner } from '../../lib/api';
export function OwnerConnection({
  authenticated,
  onConnected,
  onDisconnect,
  onError,
}: {
  authenticated: boolean;
  onConnected: () => void;
  onDisconnect: () => void;
  onError: (message: string) => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  async function connect(value: string) {
    setBusy(true);
    try {
      await connectOwner(value.trim());
      setToken('');
      onConnected();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="auth-form"
      onSubmit={(e) => {
        e.preventDefault();
        void connect(token);
      }}
    >
      <label htmlFor="owner-token">Workspace owner token</label>
      <input
        id="owner-token"
        type="password"
        autoComplete="off"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        required
        disabled={busy}
      />
      <button type="submit" disabled={busy}>
        Connect
      </button>
      {authenticated && (
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => {
            onDisconnect();
            void disconnectOwner()
              .then(onConnected)
              .catch((e) => onError(e.message));
          }}
        >
          Disconnect
        </button>
      )}
      <span className="auth-help">
        Use your workspace owner token. Provider API keys stay in Cloudflare.
      </span>
      {!authenticated && (
        <label className="token-file">
          Or connect with your owner token file
          <input
            type="file"
            aria-label="Connect with owner token file"
            disabled={busy}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (!file) return;
              if (file.size > 4096) {
                onError('Choose the small owner token file created during workspace setup.');
                return;
              }
              void file
                .text()
                .then((value) => connect(value))
                .catch(() => onError('Could not read owner token file.'));
            }}
          />
        </label>
      )}
    </form>
  );
}
