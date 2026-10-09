import { useId, useState } from 'react';
import {
  isValidAccountIdentifier,
  MAX_ACCOUNT_IDENTIFIER_LENGTH,
} from '../../../../shared/account';
import { api } from '../../lib/api';
export function AccountPanel({
  onConnected,
  initialMode = 'signup',
}: {
  onConnected: () => void;
  initialMode?: 'signup' | 'login';
}) {
  const [mode, setMode] = useState<'signup' | 'login' | 'recover'>(initialMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState('');
  const [recovered, setRecovered] = useState(false);
  const identifierHelp = useId();
  if (recovery)
    return (
      <section className="account-panel">
        <h2>Save your recovery code</h2>
        <p>This code resets your password. Store it somewhere private; it is shown once.</p>
        <code className="recovery-code">{recovery}</code>
        <button
          type="button"
          onClick={() => {
            setRecovery('');
            if (recovered) {
              setMode('login');
              setRecovered(false);
            } else onConnected();
          }}
        >
          {recovered ? 'Continue to sign in' : 'I saved it. Open workspace'}
        </button>
      </section>
    );
  return (
    <section className="account-panel">
      <nav className="account-tabs" aria-label="Account access">
        {(['signup', 'login'] as const).map((m) => (
          <button
            type="button"
            key={m}
            className={mode === m ? 'selected' : ''}
            aria-current={mode === m ? 'page' : undefined}
            disabled={busy}
            onClick={() => {
              setMode(m);
              setError('');
            }}
          >
            {m === 'signup' ? 'Create account' : 'Sign in'}
          </button>
        ))}
      </nav>
      <h2>
        {mode === 'signup'
          ? 'Create your workspace'
          : mode === 'recover'
            ? 'Recover your account'
            : 'Sign in'}
      </h2>
      <p>Your repositories, provider keys and context belong to your private workspace.</p>
      <form
        key={mode}
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          setBusy(true);
          setError('');
          try {
            const identifier = data.get('username');
            if (typeof identifier !== 'string' || !isValidAccountIdentifier(identifier))
              throw new Error('Enter a valid username or email address.');
            const result = await api<{ recovery_code?: string }>(
              `auth/${mode}`,
              Object.fromEntries(data),
            );
            form.reset();
            if (result.recovery_code) {
              setRecovery(result.recovery_code);
              setRecovered(mode === 'recover');
            } else onConnected();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Username or email
          <input
            name="username"
            required
            autoComplete="username"
            maxLength={MAX_ACCOUNT_IDENTIFIER_LENGTH}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={identifierHelp}
            placeholder="your_name or you@example.com"
          />
        </label>
        <p id={identifierHelp}>
          {mode === 'signup'
            ? 'Choose a username or use your email address.'
            : 'Enter the username or email you registered with.'}
        </p>
        {mode === 'recover' && (
          <label>
            Recovery code
            <input name="recovery_code" required autoComplete="off" />
          </label>
        )}
        <label>
          {mode === 'recover' ? 'New password' : 'Password'}
          <input
            type="password"
            name="password"
            required
            minLength={mode === 'login' ? 1 : 12}
            maxLength={128}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>
        {mode !== 'login' && <p>Use at least 12 characters. You will receive a recovery code.</p>}
        {error && <p role="alert">{error}</p>}
        <button disabled={busy} type="submit">
          {busy
            ? 'Connecting…'
            : mode === 'signup'
              ? 'Create account'
              : mode === 'recover'
                ? 'Reset password'
                : 'Sign in'}
        </button>
      </form>
      <div className="run-actions">
        {(['recover'] as const)
          .filter((m) => m !== mode)
          .map((m) => (
            <button
              type="button"
              className="text-button"
              key={m}
              disabled={busy}
              onClick={() => {
                setMode(m);
                setError('');
              }}
            >
              Use recovery code
            </button>
          ))}
      </div>
    </section>
  );
}
