// Settings → Sign-in methods: the GitHub and Google identities linked to the account, linking
// another configured provider, and unlinking one. The last way to sign in (the only identity
// of an account without a password) cannot be removed; the Worker refuses it too.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { when } from '../source-platform/sourceApi';
import { ProviderMark } from '../workspace/OAuthButtons';
import {
  canUnlink,
  isProvider,
  type SignInMethods as Methods,
  oauthStartUrl,
  PROVIDER_LABEL,
  type Provider,
} from '../workspace/oauthModel';

export function SignInMethodList({
  methods,
  busy,
  onUnlink,
  onLink,
}: {
  methods: Methods;
  busy: boolean;
  onUnlink: (provider: Provider) => void;
  onLink: (provider: Provider) => void;
}) {
  const removable = canUnlink(methods);
  const linked = new Set(methods.identities.map((i) => i.provider));
  const linkable = methods.providers.filter(isProvider).filter((p) => !linked.has(p));
  return (
    <>
      {methods.identities.length === 0 ? (
        <p className="source-empty">No sign-in provider is linked. This account uses a password.</p>
      ) : (
        <div className="source-table-wrap">
          <table className="source-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Account</th>
                <th>Linked</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {methods.identities
                .filter((i) => isProvider(i.provider))
                .map((i) => {
                  const label = PROVIDER_LABEL[i.provider as Provider];
                  return (
                    <tr key={i.provider}>
                      <td>
                        <span className="oauth-method">
                          <ProviderMark provider={i.provider as Provider} />
                          {label}
                        </span>
                      </td>
                      <td>{i.email ?? i.login}</td>
                      <td>{when(i.created_at)}</td>
                      <td>
                        <button
                          type="button"
                          className="quiet"
                          disabled={busy || !removable}
                          title={removable ? undefined : 'The only way to sign in to this account'}
                          aria-label={`Unlink ${label}`}
                          onClick={() => onUnlink(i.provider as Provider)}
                        >
                          Unlink
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
      {!removable && methods.identities.length > 0 && (
        <p className="source-meta">
          This is your only way to sign in, so it cannot be unlinked. Link another provider first.
        </p>
      )}
      {linkable.length > 0 && (
        <div className="source-actions">
          {linkable.map((provider) => (
            <button
              type="button"
              key={provider}
              className="oauth-button"
              disabled={busy}
              onClick={() => onLink(provider)}
            >
              <ProviderMark provider={provider} />
              <span>Link {PROVIDER_LABEL[provider]}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function SignInMethods() {
  const [methods, setMethods] = useState<Methods | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setLoadError('');
    api<Methods>('auth/identities').then(setMethods, (e) => setLoadError((e as Error).message));
  }, []);
  useEffect(load, [load]);
  return (
    <section className="settings-card" aria-labelledby="signin-methods-heading">
      <h2 id="signin-methods-heading">Sign-in methods</h2>
      <p className="source-meta">
        Sign in with a linked provider instead of a password. Linking never merges accounts: a
        provider account links to one YonedaRepo account only.
      </p>
      {loadError ? (
        <Failure error={loadError} onRetry={load} />
      ) : !methods ? (
        <Loading what="sign-in methods" />
      ) : (
        <SignInMethodList
          methods={methods}
          busy={busy}
          onLink={(provider) => {
            setBusy(true);
            window.location.assign(oauthStartUrl(provider, { intent: 'link' }));
          }}
          onUnlink={async (provider) => {
            if (!window.confirm(`Unlink ${PROVIDER_LABEL[provider]}? You can link it again later.`))
              return;
            setBusy(true);
            setError('');
            try {
              await api('auth/unlink', { provider });
              load();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {error && <Failure error={error} />}
    </section>
  );
}
