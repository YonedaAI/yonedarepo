import { useEffect, useId, useState } from 'react';
import {
  isValidAccountIdentifier,
  MAX_ACCOUNT_IDENTIFIER_LENGTH,
  normalizeAccountIdentifier,
} from '../../../../shared/account';
import { api } from '../../lib/api';
import { OAuthButtons, TermsNotice } from './OAuthButtons';
import { isProvider, oauthStartUrl, type Provider } from './oauthModel';

/** The sign-in providers the Worker has secrets for (none when the list cannot be read). */
function useProviders() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  useEffect(() => {
    let live = true;
    api<{ providers: unknown[] }>('auth/providers')
      .then((r) => live && setProviders(r.providers.filter(isProvider)))
      .catch(() => live && setProviders([]));
    return () => {
      live = false;
    };
  }, []);
  return providers;
}

export function AccountPanel({
  onConnected,
  initialMode = 'signup',
  initialError = '',
  initialProviders = null,
}: {
  onConnected: () => void;
  initialMode?: 'signup' | 'login';
  /** A provider sign-in that came back refused (its `auth_error`, in words). */
  initialError?: string;
  /** Providers known before the list loads (tests render without effects). */
  initialProviders?: Provider[] | null;
}) {
  const [mode, setMode] = useState<'signup' | 'login' | 'recover'>(initialMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const loaded = useProviders();
  const providers = loaded ?? initialProviders;
  const [pending, setPending] = useState<Provider | null>(null);
  const [recovery, setRecovery] = useState('');
  const [recovered, setRecovered] = useState(false);
  const identifierHelp = useId();
  const emailHelp = useId();
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
      <p>Your repositories and tokens belong to your account.</p>
      {mode !== 'recover' && (
        <OAuthButtons
          providers={providers}
          pending={pending}
          busy={busy}
          onStart={(provider) => {
            setPending(provider);
            setError('');
            window.location.assign(
              oauthStartUrl(provider, {
                returnTo: `${window.location.pathname}${window.location.search}`,
              }),
            );
          }}
        />
      )}
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
            const email = data.get('email');
            if (
              mode === 'signup' &&
              (typeof email !== 'string' || !normalizeAccountIdentifier(email)?.includes('@'))
            )
              throw new Error('Enter a valid email address.');
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
        {mode === 'signup' && (
          <>
            <label>
              Email
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                maxLength={MAX_ACCOUNT_IDENTIFIER_LENGTH}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-describedby={emailHelp}
                placeholder="you@example.com"
              />
            </label>
            <p id={emailHelp}>We send one welcome email here. It is never shown to others.</p>
          </>
        )}
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
        <button disabled={busy || pending !== null} type="submit">
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
      <TermsNotice />
    </section>
  );
}
