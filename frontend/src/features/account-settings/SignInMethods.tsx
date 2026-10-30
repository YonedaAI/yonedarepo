// Settings → Connected accounts: a row per sign-in provider, its linked identity with Disconnect
// or Not connected with Connect. Linking never merges accounts: a provider account links to one
// YonedaRepo account only. The last way to sign in (the only identity of an account without a
// password) cannot be removed; the Worker refuses it too.
import { useCallback, useEffect, useState } from 'react';
import { SettingsRow, SettingsSection } from '../../components/SettingsSection';
import { api } from '../../lib/api';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { when } from '../source-platform/sourceApi';
import { ProviderMark } from '../workspace/OAuthButtons';
import {
  canUnlink,
  type SignInMethods as Methods,
  oauthStartUrl,
  PROVIDER_LABEL,
  PROVIDERS,
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
  const identityOf = (provider: Provider) =>
    methods.identities.find((i) => i.provider === provider);
  const shown = PROVIDERS.filter((p) => identityOf(p) || methods.providers.includes(p));
  if (shown.length === 0)
    return (
      <p className="source-empty settings-block">
        No sign-in provider is linked. This account uses a password.
      </p>
    );
  return shown.map((provider) => {
    const label = PROVIDER_LABEL[provider];
    const identity = identityOf(provider);
    return (
      <SettingsRow
        key={provider}
        media={<ProviderMark provider={provider} />}
        title={label}
        detail={
          identity ? (
            <span className="settings-row-mono" title={`Connected ${when(identity.created_at)}`}>
              {identity.email ?? identity.login}
            </span>
          ) : (
            'Not connected'
          )
        }
        action={
          identity ? (
            <>
              {!removable && <span className="source-meta">Only way to sign in</span>}
              <button
                type="button"
                className="quiet"
                disabled={busy || !removable}
                title={removable ? undefined : 'The only way to sign in to this account'}
                aria-label={`Disconnect ${label}`}
                onClick={() => onUnlink(provider)}
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              className="quiet"
              disabled={busy}
              aria-label={`Connect ${label}`}
              onClick={() => onLink(provider)}
            >
              Connect
            </button>
          )
        }
      />
    );
  });
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
    <SettingsSection id="connected-accounts" title="Connected accounts">
      {loadError ? (
        <div className="settings-block">
          <Failure error={loadError} onRetry={load} />
        </div>
      ) : !methods ? (
        <div className="settings-block">
          <Loading what="connected accounts" />
        </div>
      ) : (
        <SignInMethodList
          methods={methods}
          busy={busy}
          onLink={(provider) => {
            setBusy(true);
            window.location.assign(oauthStartUrl(provider, { intent: 'link' }));
          }}
          onUnlink={async (provider) => {
            const label = PROVIDER_LABEL[provider];
            if (!window.confirm(`Disconnect ${label}? You can connect it again later.`)) return;
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
      {error && (
        <div className="settings-block">
          <Failure error={error} />
        </div>
      )}
    </SettingsSection>
  );
}
