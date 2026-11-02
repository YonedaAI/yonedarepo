// The emailed reset link's page (`/reset-password#account=…&token=…`). The account and token sit
// in the URL's fragment, which reaches no server, and useRoute takes them out of the address bar
// and the history as soon as the page opens. Reloading it asks for the email's link again. The
// token, like the new recovery code, lives only in this page's memory. Works signed in or out;
// a reset ends every session and token, so it leads to the sign-in page (a full load, which forgets both).
import { type FormEvent, useState } from 'react';
import { api } from '../../lib/api';
import { RecoveryCodeShown } from './RecoveryCodeShown';

const SignInLink = () => <a href="/signin">Back to sign in</a>;

export function ResetPasswordPage({ account, token }: { account: string; token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    try {
      const password = new FormData(form).get('password');
      const result = await api<{ recovery_code: string }>('auth/password/reset', {
        account,
        token,
        password,
      });
      form.reset();
      setRecovery(result.recovery_code);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (recovery)
    return (
      <div className="source-device reset-password">
        <h1>Save your recovery code</h1>
        <section className="account-panel">
          <p role="status">Your password is set. You are signed out everywhere.</p>
          <RecoveryCodeShown code={recovery} />
          <a className="button-link" href="/signin">
            Continue to sign in
          </a>
        </section>
      </div>
    );
  return (
    <div className="source-device reset-password">
      <h1>Set a new password</h1>
      <section className="account-panel">
        {!account || !token ? (
          <>
            <p role="alert">This link is incomplete. Open the whole link from the email.</p>
            <SignInLink />
          </>
        ) : (
          <form onSubmit={submit}>
            <input
              type="text"
              name="username"
              value={account}
              autoComplete="username"
              readOnly
              hidden
            />
            <label>
              New password
              <input
                type="password"
                name="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </label>
            <p className="field-help">At least 12 characters. You get a recovery code next.</p>
            <p className="field-help">This also revokes every token and CLI sign-in.</p>
            {error && (
              <p role="alert" className="form-error">
                {error} <SignInLink />
              </p>
            )}
            <button type="submit" disabled={busy}>
              {busy ? 'Setting password…' : 'Set password'}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
