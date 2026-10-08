import { useState } from 'react';
import { api } from '../../lib/api';
export function AccountPanel({ onConnected }: { onConnected: () => void }) {
  const [mode, setMode] = useState<'signup' | 'login' | 'recover'>('signup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState('');
  const [recovered, setRecovered] = useState(false);
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
          Username
          <input
            name="username"
            required
            autoComplete="username"
            pattern="[A-Za-z][A-Za-z0-9_]{2,31}"
            placeholder="your_name"
          />
        </label>
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
