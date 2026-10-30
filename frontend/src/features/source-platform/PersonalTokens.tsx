// Personal access tokens (`ypat_…`): account-wide tokens for the yoneda CLI and agents,
// with scopes, an optional repository allowlist, an optional organization limit and an
// expiry. Created from the session, shown once, revocable.
import { type FormEvent, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { SettingsRow, SettingsSection } from '../../components/SettingsSection';
import {
  DEFAULT_EXPIRY_DAYS,
  DEFAULT_PAT_SCOPES,
  expiresIn,
  PAT_SCOPES,
  type PatScope,
} from './connect';
import type { OrgSummary } from './orgModel';
import { Failure, Loading } from './SourceStatus';
import { sourceApi, when } from './sourceApi';
import {
  ExpirySelect,
  RepoAllowlist,
  type RepoSummary,
  ScopeChecks,
  ShownOnce,
} from './TokenParts';
import type { Loaded } from './useSource';

export type Pat = {
  id: string;
  name: string;
  scopes: string[];
  repos: string[] | null;
  /** The one organization whose repositories it reaches (null: not limited). */
  org?: string | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  /** `login`: made by `yoneda login` (the device flow); null: made on the website. */
  origin?: 'login' | null;
  /** The machine a login token was signed in on (null when unknown). */
  host?: string | null;
};

export function PatTable({
  tokens,
  repos,
  onRevoke,
  now = Date.now(),
}: {
  tokens: Loaded<{ tokens: Pat[] }>;
  repos: RepoSummary[];
  onRevoke: (token: Pat) => void;
  now?: number;
}) {
  if (tokens.loading && !tokens.data) return <Loading what="tokens" />;
  if (tokens.error) return <Failure error={tokens.error} onRetry={tokens.reload} />;
  const list = tokens.data?.tokens ?? [];
  if (list.length === 0) return <p className="source-empty">No personal access tokens yet.</p>;
  const name = (id: string) => repos.find((r) => r.id === id)?.name ?? id;
  return (
    <div className="source-table-wrap">
      <table className="source-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Scopes</th>
            <th>Repositories</th>
            <th>Organization</th>
            <th>Expires</th>
            <th>Last used</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>{t.scopes.join(', ')}</td>
              <td>{t.repos ? t.repos.map(name).join(', ') : 'all'}</td>
              <td>{t.org ?? 'any'}</td>
              <td>{expiresIn(t.expires_at, now)}</td>
              <td>{t.last_used_at ? when(t.last_used_at) : 'never'}</td>
              <td>
                <button
                  type="button"
                  className="quiet"
                  aria-label={`Revoke ${t.name}`}
                  onClick={() => onRevoke(t)}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A token `yoneda login` made (the platform records its origin; older ones were marked by
 * their client name when origins began to be recorded). */
export const isDeviceLogin = (token: Pat) => token.origin === 'login';

/** Only `which` of the account's tokens, keeping the read's state. */
export const onlyTokens = (
  tokens: Loaded<{ tokens: Pat[] }>,
  which: (token: Pat) => boolean,
): Loaded<{ tokens: Pat[] }> =>
  tokens.data ? { ...tokens, data: { tokens: tokens.data.tokens.filter(which) } } : tokens;

/** The `POST /tokens` body: only the limits the form set (no org and no repositories: all). */
export function patBody(form: {
  name: string;
  scopes: PatScope[];
  days: number;
  repos: string[];
  org: string;
}) {
  return {
    name: form.name.trim(),
    scopes: form.scopes,
    expires_days: form.days,
    ...(form.repos.length ? { repos: form.repos } : {}),
    ...(form.org ? { org: form.org } : {}),
  };
}

/** Revokes a personal token after confirming, then re-reads the list. */
export async function revokePat(token: Pat, tokens: Loaded<unknown>, what = 'Clients using it') {
  if (!window.confirm(`Revoke ${token.name}? ${what} stop working immediately.`)) return;
  await sourceApi(`/tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' });
  tokens.reload();
}

/** Optional organization limit: the token reaches only that org's repositories and cannot
 * create organizations or repositories outside it. */
export function OrgLimit({
  orgs,
  value,
  onChange,
}: {
  orgs: OrgSummary[];
  value: string;
  onChange: (org: string) => void;
}) {
  const names = orgs.map((o) => o.org).sort();
  return (
    <label htmlFor="pat-org" className="source-field">
      Organization
      <select id="pat-org" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any (not limited)</option>
        {names.map((org) => (
          <option key={org} value={org}>
            Only {org}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The new-token form: `onCreated` takes the secret, shown once. */
export function PatDialog({
  repos,
  orgs,
  onCreated,
  onClose,
}: {
  repos: RepoSummary[];
  orgs: OrgSummary[];
  onCreated: (secret: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<PatScope[]>(DEFAULT_PAT_SCOPES);
  const [days, setDays] = useState(DEFAULT_EXPIRY_DAYS);
  const [allow, setAllow] = useState<string[]>([]);
  const [org, setOrg] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await sourceApi<{ token: string }>('/tokens', {
        body: patBody({ name, scopes, days, repos: allow, org }),
      });
      onCreated(created.token);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog title="Create token" onClose={onClose} locked={busy} initialFocus="#pat-name">
      <form
        onSubmit={create}
        className="source-token-form"
        aria-label="Create a personal access token"
      >
        <label htmlFor="pat-name" className="source-field">
          Name
          <input
            id="pat-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="laptop, ci, cloud agent"
            maxLength={100}
            required
          />
        </label>
        <ScopeChecks legend="Scopes" options={PAT_SCOPES} value={scopes} onChange={setScopes} />
        <ExpirySelect id="pat-expiry" value={days} onChange={setDays} />
        <RepoAllowlist repos={repos} value={allow} onChange={setAllow} />
        {orgs.length > 0 && <OrgLimit orgs={orgs} value={org} onChange={setOrg} />}
        {error && <Failure error={error} />}
        <div className="run-actions">
          <button type="submit" disabled={busy || !name.trim() || scopes.length === 0}>
            {busy ? 'Creating…' : 'Create token'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function PersonalTokens({
  repos,
  orgs = [],
  tokens: all,
}: {
  repos: RepoSummary[];
  /** The account's organizations, for the organization limit. */
  orgs?: OrgSummary[];
  tokens: Loaded<{ tokens: Pat[] }>;
}) {
  const tokens = onlyTokens(all, (t) => !isDeviceLogin(t));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');

  async function revoke(token: Pat) {
    setError('');
    try {
      await revokePat(token, tokens);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <SettingsSection id="pat" title="Personal access tokens">
      <SettingsRow
        title="Git, agents and CI"
        detail={
          <>
            Use a token as your Git password, or give one to a cloud agent.{' '}
            <code>yoneda login</code> creates its own.
          </>
        }
        action={
          <button type="button" className="quiet" onClick={() => setCreating(true)}>
            Create token
          </button>
        }
      />
      {creating && (
        <PatDialog
          repos={repos}
          orgs={orgs}
          onClose={() => setCreating(false)}
          onCreated={(token) => {
            setSecret(token);
            setCreating(false);
            tokens.reload();
          }}
        />
      )}
      {secret && (
        <div className="settings-block">
          <ShownOnce token={secret} onDone={() => setSecret('')} />
        </div>
      )}
      <PatTable tokens={tokens} repos={repos} onRevoke={revoke} />
      {error && (
        <div className="settings-block">
          <Failure error={error} />
        </div>
      )}
    </SettingsSection>
  );
}
