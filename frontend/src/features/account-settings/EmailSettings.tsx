// Settings → Email: the account's contact email (used only for account email, never shown to
// others) and whether it is confirmed, a new confirmation link, and changing the address in a
// dialog (which clears the confirmation and sends a link to the new one). The Worker limits
// links and changes to five a day.
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { SettingsRow, SettingsSection } from '../../components/SettingsSection';
import { api } from '../../lib/api';
import { Failure, Loading } from '../source-platform/SourceStatus';

export type EmailStatus = { email: string | null; verified: boolean };

/** Sends the confirmation link: `onChange` answers why it failed, or '' once it went. */
export function EmailDialog({
  current,
  busy,
  onChange,
  onClose,
}: {
  current: string | null;
  busy: boolean;
  onChange: (email: string) => Promise<string>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const problem = await onChange(draft);
    if (problem) setError(problem);
    else onClose();
  };
  return (
    <Dialog
      title={current ? 'Change email' : 'Add email'}
      onClose={onClose}
      locked={busy}
      initialFocus="#account-email"
    >
      <form onSubmit={submit}>
        <label htmlFor="account-email">
          Email
          <input
            id="account-email"
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
        {error && <Failure error={error} />}
        <div className="run-actions">
          <button type="submit" disabled={busy || !draft.trim()}>
            Send confirmation link
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function EmailAddress({
  status,
  busy,
  onResend,
  onChange,
}: {
  status: EmailStatus;
  busy: boolean;
  onResend: () => void;
  onChange: (email: string) => Promise<string>;
}) {
  const [changing, setChanging] = useState(false);
  return (
    <>
      <SettingsRow
        title={status.email ?? 'No email address'}
        detail={
          status.email
            ? status.verified
              ? 'Confirmed'
              : 'Not confirmed. We sent a confirmation link to this address.'
            : 'Only used for account email, never shown to others.'
        }
        action={
          <>
            {status.email && !status.verified && (
              <button type="button" className="quiet" disabled={busy} onClick={onResend}>
                Resend confirmation
              </button>
            )}
            <button type="button" className="quiet" onClick={() => setChanging(true)}>
              {status.email ? 'Change' : 'Add'}
            </button>
          </>
        }
      />
      {changing && (
        <EmailDialog
          current={status.email}
          busy={busy}
          onChange={onChange}
          onClose={() => setChanging(false)}
        />
      )}
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
  /** Why it failed, or '' once it went. */
  const act = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(path, body);
      setNotice(done);
      load();
      return '';
    } catch (e) {
      return (e as Error).message;
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection id="email" title="Email">
      {loadError ? (
        <div className="settings-block">
          <Failure error={loadError} onRetry={load} />
        </div>
      ) : !status ? (
        <div className="settings-block">
          <Loading what="your email address" />
        </div>
      ) : (
        <EmailAddress
          status={status}
          busy={busy}
          onResend={() => {
            void act('auth/email/resend', {}, 'Confirmation link sent.').then(setError);
          }}
          onChange={(email) =>
            act('auth/email', { email }, `Confirmation link sent to ${email.trim()}.`)
          }
        />
      )}
      {(notice || error) && (
        <div className="settings-block">
          {notice && <p role="status">{notice}</p>}
          {error && <Failure error={error} />}
        </div>
      )}
    </SettingsSection>
  );
}
