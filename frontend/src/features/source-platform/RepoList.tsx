import { type FormEvent, useState } from 'react';
import { Failure, Loading } from './SourceStatus';
import { sourceApi } from './sourceApi';
import type { SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

type Repo = { id: string; name: string; created_at: number };

export function RepoList({
  selected,
  onNavigate,
}: {
  selected?: string;
  onNavigate: (route: SourceRoute) => void;
}) {
  const repos = useSource<{ repos: Repo[] }>('/repos');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await sourceApi<{ id: string }>('/repos', {
        body: {
          name,
          policy: { required_checks: [], approvals: 1 },
          files: [{ path: 'README.md', content_b64: btoa(`# ${name}\n`) }],
          author: { name: 'Repository owner', email: 'owner@yonedarepo.invalid' },
        },
      });
      setName('');
      repos.reload();
      onNavigate({ view: 'files', repo: created.id, path: '', ref: 'main' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <nav className="source-repos" aria-label="Repositories">
      <h2>Repositories</h2>
      {repos.loading && !repos.data && <Loading what="repositories" />}
      {repos.error && <Failure error={repos.error} onRetry={repos.reload} />}
      {repos.data && repos.data.repos.length === 0 && (
        <p className="source-empty">No repositories yet. Create one below or import a fixture.</p>
      )}
      <ul>
        {repos.data?.repos.map((repo) => (
          <li key={repo.id}>
            <a
              href={`/source/${repo.id}`}
              aria-current={repo.id === selected ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault();
                onNavigate({ view: 'files', repo: repo.id, path: '', ref: 'main' });
              }}
            >
              {repo.name}
            </a>
          </li>
        ))}
      </ul>
      <form onSubmit={create} className="source-create">
        <label htmlFor="source-new-name">New repository</label>
        <input
          id="source-new-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          pattern="[A-Za-z0-9_\-][A-Za-z0-9._\-]{0,99}"
          placeholder="name"
          required
        />
        <button type="submit" disabled={busy || !name}>
          {busy ? 'Creating…' : 'Create'}
        </button>
        {error && <Failure error={error} />}
      </form>
    </nav>
  );
}
