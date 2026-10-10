import { useState } from 'react';
import { api } from '../../lib/api';
export function ReviewerAccess({ onConnected }: { onConnected: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <details className="account-panel">
      <summary>Have a reviewer access key?</summary>
      <p>Your sandbox and funded agents are ready. No signup or provider key needed.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api('auth/login', { username: 'reviewer', password: key });
            setKey('');
            onConnected();
          } catch (e) {
            setKey('');
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Reviewer access key
          <input
            type="password"
            required
            autoComplete="current-password"
            maxLength={128}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button disabled={busy} type="submit">
          {busy ? 'Opening…' : 'Open reviewer workspace'}
        </button>
      </form>
    </details>
  );
}
