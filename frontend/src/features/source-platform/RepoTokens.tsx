// Repository tokens (`yrp_…`): scoped to one repository (and optionally to paths), for an
// agent or CI that should touch nothing else. Owner-only; shown once, revocable by name.
import { type FormEvent, useState } from 'react';
import { REPO_TOKEN_SCOPES, scopeList } from './connect';
import { Failure, Loading } from './SourceStatus';
import { sourceApi, when } from './sourceApi';
import { type RepoSummary, ScopeChecks, ShownOnce } from './TokenParts';
import { type Loaded, useSource } from './useSource';

export type RepoToken = {
  name: string;
  scopes: unknown;
  paths?: unknown;
  created_at?: number;
  revoked_at?: number | null;
};
type Scope = (typeof REPO_TOKEN_SCOPES)[number];
const OPTIONS = REPO_TOKEN_SCOPES.map((scope) => ({ scope, label: scope }));

export function RepoTokenTable({
  tokens,
  onRevoke,
}: {
  tokens: Loaded<{ tokens: RepoToken[] }>;
  onRevoke: (name: string) => void;
}) {
  if (tokens.loading && !tokens.data) return <Loading what="repository tokens" />;
  if (tokens.error) return <Failure error={tokens.error} onRetry={tokens.reload} />;
  const live = (tokens.data?.tokens ?? []).filter((t) => !t.revoked_at);
  if (live.length === 0) return <p className="source-empty">No repository tokens.</p>;
  return (
    <div className="source-table-wrap">
      <table className="source-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Scopes</th>
            <th>Paths</th>
            <th>Created</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {live.map((t) => (
            <tr key={t.name}>
              <td>{t.name}</td>
              <td>{scopeList(t.scopes).join(', ')}</td>
              <td>{scopeList(t.paths).join(', ') || 'all'}</td>
              <td>{when(t.created_at)}</td>
              <td>
                <button type="button" className="quiet" onClick={() => onRevoke(t.name)}>
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

export function RepoTokens({ repos }: { repos: RepoSummary[] }) {
  const [repo, setRepo] = useState('');
  const selected = repo || repos[0]?.id || '';
  const tokens = useSource<{ tokens: RepoToken[] }>(selected ? `/repos/${selected}/tokens` : null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['read', 'write']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await sourceApi<{ token: string }>(`/repos/${selected}/tokens`, {
        body: { name, scopes },
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
  async function revoke(token: string) {
    if (!window.confirm(`Revoke ${token}? Clients using it stop working immediately.`)) return;
    setError('');
    try {
      await sourceApi(`/repos/${selected}/tokens/${encodeURIComponent(token)}`, {
        method: 'DELETE',
      });
      tokens.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section aria-labelledby="repo-token-heading">
      <h2 id="repo-token-heading">Repository tokens</h2>
      <p className="source-meta">
        Scoped to one repository, for an agent that should touch nothing else.
      </p>
      {repos.length === 0 ? (
        <p className="source-empty">Create a repository first.</p>
      ) : (
        <>
          <label htmlFor="repo-token-repo" className="source-field">
            Repository
            <select id="repo-token-repo" value={selected} onChange={(e) => setRepo(e.target.value)}>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <RepoTokenTable tokens={tokens} onRevoke={revoke} />
          {secret ? (
            <ShownOnce token={secret} onDone={() => setSecret('')} />
          ) : (
            <form onSubmit={create} className="source-token-form">
              <label htmlFor="repo-token-name" className="source-field">
                Name
                <input
                  id="repo-token-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  pattern="[a-z0-9][a-z0-9._\-]{0,63}"
                  title="lowercase letters, digits, and . _ - after the first character"
                  required
                />
              </label>
              <ScopeChecks legend="Scopes" options={OPTIONS} value={scopes} onChange={setScopes} />
              <button type="submit" disabled={busy || !name || scopes.length === 0}>
                {busy ? 'Creating…' : 'Create repository token'}
              </button>
            </form>
          )}
        </>
      )}
      {error && <Failure error={error} />}
    </section>
  );
}
