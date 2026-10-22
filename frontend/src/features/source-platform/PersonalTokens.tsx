// Personal access tokens (`ypat_…`): account-wide tokens for the yoneda CLI and agents,
// with scopes, an optional repository allowlist and an expiry. Created from the session,
// shown once, revocable.
import { type FormEvent, useState } from 'react';
import {
  DEFAULT_EXPIRY_DAYS,
  DEFAULT_PAT_SCOPES,
  expiresIn,
  PAT_SCOPES,
  type PatScope,
} from './connect';
import { Failure, Loading } from './SourceStatus';
import { sourceApi, when } from './sourceApi';
import {
  ExpirySelect,
  RepoAllowlist,
  type RepoSummary,
  ScopeChecks,
  ShownOnce,
} from './TokenParts';
import { type Loaded, useSource } from './useSource';

export type Pat = {
  id: string;
  name: string;
  scopes: string[];
  repos: string[] | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
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
  if (list.length === 0)
    return <p className="source-empty">No personal access tokens. Create one below.</p>;
  const name = (id: string) => repos.find((r) => r.id === id)?.name ?? id;
  return (
    <div className="source-table-wrap">
      <table className="source-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Scopes</th>
            <th>Repositories</th>
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
              <td>{expiresIn(t.expires_at, now)}</td>
              <td>{t.last_used_at ? when(t.last_used_at) : 'never'}</td>
              <td>
                <button type="button" className="quiet" onClick={() => onRevoke(t)}>
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

export function PersonalTokens({ repos }: { repos: RepoSummary[] }) {
  const tokens = useSource<{ tokens: Pat[] }>('/tokens');
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<PatScope[]>(DEFAULT_PAT_SCOPES);
  const [days, setDays] = useState(DEFAULT_EXPIRY_DAYS);
  const [allow, setAllow] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await sourceApi<{ token: string }>('/tokens', {
        body: {
          name,
          scopes,
          expires_days: days,
          ...(allow.length ? { repos: allow } : {}),
        },
      });
      setSecret(created.token);
      setName('');
      tokens.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(token: Pat) {
    if (!window.confirm(`Revoke ${token.name}? Clients using it stop working immediately.`)) return;
    setError('');
    try {
      await sourceApi(`/tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' });
      tokens.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section aria-labelledby="pat-heading">
      <h2 id="pat-heading">Personal access tokens</h2>
      <p className="source-meta">
        For the yoneda CLI and agents across your repositories. <code>yoneda login</code> creates
        one through the browser; create one here for a cloud agent or CI.
      </p>
      <PatTable tokens={tokens} repos={repos} onRevoke={revoke} />
      {secret ? (
        <ShownOnce token={secret} onDone={() => setSecret('')} />
      ) : (
        <form onSubmit={create} className="source-token-form">
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
          <button type="submit" disabled={busy || !name || scopes.length === 0}>
            {busy ? 'Creating…' : 'Create token'}
          </button>
        </form>
      )}
      {error && <Failure error={error} />}
    </section>
  );
}
