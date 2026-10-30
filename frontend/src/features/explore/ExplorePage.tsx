// Explore (`/source/explore`): public repositories, newest first, for anyone signed in or
// not. Each opens on its files; "Load more" reads the page before the oldest shown.
import { ArrowRight, GitBranch } from 'lucide-react';
import { useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { PublicBadge } from '../source-platform/PublicBadge';
import { usePeople } from '../source-platform/people';
import { rememberRepoName } from '../source-platform/repoNames';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { sourceApi } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import { createdOn, type ExploreRepo, exploreList, explorePath } from './exploreModel';

type Page = { repos: ExploreRepo[] };

export function ExplorePage({
  authenticated,
  navigate,
}: {
  authenticated: boolean;
  navigate: Navigate;
}) {
  const people = usePeople();
  const first = useSource<Page>(explorePath());
  const [later, setLater] = useState<ExploreRepo[][]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { repos, next } = exploreList(first.data ? [first.data.repos, ...later] : []);
  for (const r of repos) rememberRepoName(r.id, r.owner_handle, r.name);
  async function loadMore() {
    if (next === undefined) return;
    setBusy(true);
    setError('');
    try {
      const page = await sourceApi<Page>(explorePath(next));
      setLater((pages) => [...pages, page.repos]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="home-repos explore" aria-labelledby="explore-heading">
      <div className="page-heading">
        <h1 id="explore-heading">Explore</h1>
      </div>
      <p className="source-meta">
        Public repositories: anyone can read and clone them, even without an account.
        {authenticated && ' Make one of yours public from its Settings → Visibility.'}
      </p>
      {first.loading && !first.data && <Loading what="public repositories" />}
      {first.error && (
        <Failure
          error={first.error}
          onRetry={() => {
            setLater([]);
            first.reload();
          }}
        />
      )}
      {first.data && repos.length === 0 && (
        <p className="source-empty">No public repositories yet.</p>
      )}
      {repos.length > 0 && (
        <ul className="home-repo-list" aria-label="Public repositories" aria-busy={busy}>
          {repos.map((r) => (
            <li key={r.id}>
              <a {...linkTo({ view: 'files', repo: r.id, path: '', ref: 'main' }, navigate)}>
                <GitBranch size={18} aria-hidden="true" />
                <span className="home-repo-text">
                  <strong className="home-repo-name">
                    {r.name} <PublicBadge />
                  </strong>
                  <small className="home-repo-meta">
                    {r.owner_handle ?? people.account(r.owner)} · created {createdOn(r.created_at)}
                  </small>
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      )}
      {error && <Failure error={error} onRetry={loadMore} />}
      {next !== undefined && (
        <button type="button" className="quiet explore-more" disabled={busy} onClick={loadMore}>
          {busy ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
