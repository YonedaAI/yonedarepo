import { useEffect, useId, useState } from 'react';
import {
  isValidAccountIdentifier,
  MAX_ACCOUNT_IDENTIFIER_LENGTH,
  normalizeAccountIdentifier,
} from '../../../../shared/account';
import { api } from '../../lib/api';
import { RecoveryCodeShown } from '../account-settings/RecoveryCodeShown';
import { landingSource, tabStorage } from '../site/landingSource';
import { ForgotPassword } from './ForgotPassword';
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

export type AccountMode = 'signup' | 'login' | 'recover' | 'forgot';

const TITLES: Record<AccountMode, string> = {
  signup: 'Create your workspace',
  login: 'Sign in',
  recover: 'Recover your account',
  forgot: 'Reset your password',
};
export const accountTitle = (mode: AccountMode) => TITLES[mode];

export function AccountPanel({
  onConnected,
  initialMode = 'signup',
  initialError = '',
  initialProviders = null,
  onMode,
}: {
  onConnected: () => void;
  initialMode?: AccountMode;
  /** A provider sign-in that came back refused (its `auth_error`, in words). */
  initialError?: string;
  /** Providers known before the list loads (tests render without effects). */
  initialProviders?: Provider[] | null;
  /** Set where the page's own heading follows the form: the card leaves out its heading. */
  onMode?: (mode: AccountMode) => void;
}) {
  const [mode, setMode] = useState<AccountMode>(initialMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const loaded = useProviders();
  const providers = loaded ?? initialProviders;
  const [pending, setPending] = useState<Provider | null>(null);
  const [recovery, setRecovery] = useState('');
  const [recovered, setRecovered] = useState(false);
  const identifierHelp = useId();
  const passwordField = useId();
  const choose = (next: AccountMode) => {
    setMode(next);
    onMode?.(next);
    setError('');
  };
  if (recovery)
    return (
      <section className="account-panel">
        <h2>Save your recovery code</h2>
        <RecoveryCodeShown code={recovery} />
        <button
          type="button"
          onClick={() => {
            setRecovery('');
            if (recovered) {
              choose('login');
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
            onClick={() => choose(m)}
          >
            {m === 'signup' ? 'Create account' : 'Sign in'}
          </button>
        ))}
      </nav>
      {!onMode && <h2>{accountTitle(mode)}</h2>}
      {mode !== 'forgot' && <TermsNotice />}
      {mode !== 'recover' && mode !== 'forgot' && (
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
                source: landingSource(tabStorage()),
              }),
            );
          }}
        />
      )}
      {mode === 'forgot' ? (
        <ForgotPassword busy={busy} onBusy={setBusy} />
      ) : (
        <form
          key={mode}
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const data = new FormData(form);
            setBusy(true);
            setError('');
            try {
              if (mode === 'signup') {
                const email = data.get('email');
                if (typeof email !== 'string' || !normalizeAccountIdentifier(email)?.includes('@'))
                  throw new Error('Enter a valid email address.');
              } else {
                const identifier = data.get('username');
                if (typeof identifier !== 'string' || !isValidAccountIdentifier(identifier))
                  throw new Error('Enter a valid username or email address.');
              }
              const result = await api<{ recovery_code?: string }>(`auth/${mode}`, {
                ...Object.fromEntries(data),
                ...(mode === 'signup' ? { source: landingSource(tabStorage()) } : {}),
              });
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
          {mode === 'signup' ? (
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
                  placeholder="you@example.com"
                />
              </label>
            </>
          ) : (
            <>
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
              <p id={identifierHelp} className="field-help">
                The username or email you signed up with.
              </p>
            </>
          )}
          {mode === 'recover' && (
            <label>
              Recovery code
              <input name="recovery_code" required autoComplete="off" />
            </label>
          )}
          {/* The link shows beside the label; after the input, so Tab reaches the password first. */}
          <div className="account-password">
            <label htmlFor={passwordField}>
              {mode === 'recover' ? 'New password' : 'Password'}
            </label>
            <input
              id={passwordField}
              type="password"
              name="password"
              required
              minLength={mode === 'login' ? 1 : 12}
              maxLength={128}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
            {mode === 'login' && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => choose('forgot')}
              >
                Forgot password?
              </button>
            )}
          </div>
          {mode !== 'login' && (
            <p className="field-help">At least 12 characters. You get a recovery code next.</p>
          )}
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
      )}
      {mode !== 'recover' && (
        <div className="run-actions">
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => choose('recover')}
          >
            Use recovery code
          </button>
        </div>
      )}
    </section>
  );
}
