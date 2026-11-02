// Settings → General's last section: deleting the account. The dialog reads what would go and
// what stands in the way, and asks for the handle. A session signed in a while ago signs in again
// first, by whichever way the account has: a password is not the only way in.
import { type FormEvent, type ReactNode, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { SettingsRow, SettingsSection } from '../../components/SettingsSection';
import { api } from '../../lib/api';
import type { AccountIdentity } from '../../lib/types';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { sourceApi } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import {
  CLOSURE_PATH,
  type Closure,
  closureLines,
  confirmMatches,
  DELETED_HOME,
} from './deleteAccountModel';

function Actions({ onClose, children }: { onClose: () => void; children?: ReactNode }) {
  return (
    <div className="new-repository-actions">
      <button type="button" className="quiet" onClick={onClose}>
        {children ? 'Cancel' : 'Close'}
      </button>
      {children}
    </div>
  );
}

function SignInAgain({ onClose }: { onClose: () => void }) {
  const leave = async () => {
    await api('auth/logout', {});
    window.location.assign('/signin');
  };
  return (
    <>
      <p>Sign in again first, then come back to Settings.</p>
      <Actions onClose={onClose}>
        <button type="button" onClick={() => void leave()}>
          Sign in again
        </button>
      </Actions>
    </>
  );
}

function ConfirmForm({ closure, onClose }: { closure: Closure; onClose: () => void }) {
  const expected = closure.handle ?? closure.account;
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove(event: FormEvent) {
    event.preventDefault();
    if (busy || !confirmMatches(typed, expected)) return;
    setBusy(true);
    setError('');
    try {
      await sourceApi(CLOSURE_PATH, { body: { confirm: typed.trim() } });
      window.location.assign(DELETED_HOME);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <form className="new-repository" onSubmit={remove}>
      <p>This can't be undone. These go with it:</p>
      <ul>
        {closureLines(closure).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="source-meta">Your email and sign-in methods are free to use again at once.</p>
      <label>
        <span>
          Type <strong>{expected}</strong> to confirm
        </span>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          disabled={busy}
        />
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <Actions onClose={onClose}>
        <button
          type="submit"
          className="danger"
          disabled={busy || !confirmMatches(typed, expected)}
        >
          {busy ? 'Deleting…' : 'Delete account'}
        </button>
      </Actions>
    </form>
  );
}

function DeleteDialog({ onClose }: { onClose: () => void }) {
  const closure = useSource<Closure>(CLOSURE_PATH);
  const d = closure.data;
  return (
    <Dialog title="Delete account" onClose={onClose}>
      {closure.error && <Failure error={closure.error} onRetry={closure.reload} />}
      {!d && !closure.error && <Loading what="your account" />}
      {d && d.refusals.length > 0 && (
        <>
          <p>You can't delete this account yet.</p>
          <ul>
            {d.refusals.map((r) => (
              <li key={r.message}>{r.message}</li>
            ))}
          </ul>
          <Actions onClose={onClose} />
        </>
      )}
      {d && d.refusals.length === 0 && !d.fresh && <SignInAgain onClose={onClose} />}
      {d && d.refusals.length === 0 && d.fresh && <ConfirmForm closure={d} onClose={onClose} />}
    </Dialog>
  );
}

export function DeleteAccount({ identity }: { identity: AccountIdentity }) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection id="delete-account" title="Delete account">
      <SettingsRow
        title={identity.handle ?? identity.username}
        detail="Your repositories, tokens and keys go with it."
        action={
          <button type="button" className="danger" onClick={() => setOpen(true)}>
            Delete account
          </button>
        }
      />
      {open && <DeleteDialog onClose={() => setOpen(false)} />}
    </SettingsSection>
  );
}
