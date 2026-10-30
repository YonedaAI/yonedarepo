// Settings → Email: the account's contact email and whether it is confirmed, a new
// confirmation link, and changing the address (which clears the confirmation and sends a link
// to the new one). The Worker limits links and changes to five a day.
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Failure, Loading } from '../source-platform/SourceStatus';

export type EmailStatus = { email: string | null; verified: boolean };

export function EmailAddress({
  status,
  busy,
  onResend,
  onChange,
}: {
  status: EmailStatus;
  busy: boolean;
  onResend: () => void;
  onChange: (email: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onChange(draft);
  };
  return (
    <>
      <dl className="settings-facts">
        <dt>Email</dt>
        <dd>
          {status.email ? (
            <>
              <code>{status.email}</code> ·{' '}
              <span className="source-meta">{status.verified ? 'Confirmed' : 'Not confirmed'}</span>
            </>
          ) : (
            'No email address'
          )}
        </dd>
      </dl>
      {status.email && !status.verified && (
        <p className="source-meta">
          We sent a confirmation link to this address.{' '}
          <button type="button" className="quiet" disabled={busy} onClick={onResend}>
            Resend confirmation
          </button>
        </p>
      )}
      <form onSubmit={submit} className="source-token-form">
        <label className="source-field">
          {status.email ? 'Change email' : 'Add email'}
          <input
            type="email"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            required
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="you@example.com"
          />
        </label>
        <div className="source-actions">
          <button type="submit" disabled={busy || !draft.trim()}>
            Send confirmation link
          </button>
        </div>
      </form>
    </>
  );
}

export function EmailSettings() {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setLoadError('');
    api<EmailStatus>('auth/email').then(setStatus, (e) => setLoadError((e as Error).message));
  }, []);
  useEffect(load, [load]);
  const act = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(path, body);
      setNotice(done);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-card" aria-labelledby="email-heading">
      <h2 id="email-heading">Email</h2>
      <p className="source-meta">
        Used only for account email (the welcome and confirmation emails). It is never shown to
        others.
      </p>
      {loadError ? (
        <Failure error={loadError} onRetry={load} />
      ) : !status ? (
        <Loading what="your email address" />
      ) : (
        <EmailAddress
          status={status}
          busy={busy}
          onResend={() => void act('auth/email/resend', {}, 'Confirmation link sent.')}
          onChange={(email) =>
            void act('auth/email', { email }, `Confirmation link sent to ${email.trim()}.`)
          }
        />
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <Failure error={error} />}
    </section>
  );
}
