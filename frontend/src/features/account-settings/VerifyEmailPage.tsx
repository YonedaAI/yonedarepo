// The contact email's confirmation page (`/verify-email?account=…&token=…`, the emailed
// link). Opening it confirms nothing, so a mail scanner that follows links cannot: only the
// Confirm button POSTs the token. Works signed in or out.
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';

export function VerifyEmailPage({ account, token }: { account: string; token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('auth/email/verify', { account, token });
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="source-device">
      <h1>Confirm your email</h1>
      {done ? (
        <p role="status">Your email address is confirmed. You can close this page.</p>
      ) : !account || !token ? (
        <p role="alert">
          This link is incomplete. Open the whole link from the email, or ask for a new one in
          Settings.
        </p>
      ) : (
        <form onSubmit={submit} className="source-token-form">
          <p>
            Confirm the email address of the YonedaRepo account <code>{account}</code>. The link
            works once, for 24 hours.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="source-actions">
            <button type="submit" disabled={busy}>
              {busy ? 'Confirming…' : 'Confirm'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
