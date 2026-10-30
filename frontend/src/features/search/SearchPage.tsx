// The Search page (`/search`, the rail's Search): one box and a repository picker over the
// repositories' own search API, across all of them (searchAllModel.ts) or in one. A search runs
// on Enter, not as you type: across all repositories each one would be up to 25 requests. The
// query and repository live in the address. `/` focuses the box and Escape clears it.
import { Search } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { ActivitySession } from '../shell/homeModel';
import { type PlatformRepo, repoRows } from '../shell/repoRows';
import type { Navigate } from '../shell/useRoute';
import { repoNameOf } from '../source-platform/repoNames';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { SearchResults } from './SearchResults';
import { isTyping, MIN_QUERY, searchPlan } from './searchAllModel';
import { type SearchRoute, searchRoute } from './searchRoute';
import { useSearchAcross } from './useSearchAcross';

function Welcome({ onSignIn }: { onSignIn?: () => void }) {
  return (
    <div className="search-welcome">
      <Search size={28} aria-hidden="true" />
      <h2>Search across your repositories</h2>
      <p>Find commits, sessions and code across all of your repositories.</p>
      {onSignIn && (
        <button type="button" onClick={onSignIn}>
          Sign in
        </button>
      )}
    </div>
  );
}

export function SearchPage({
  route,
  authenticated,
  repos,
  sessions,
  loading,
  reposError,
  onRetry,
  navigate,
  onSignIn,
  onNew,
}: {
  route: SearchRoute;
  authenticated: boolean;
  /** The account's repositories, as `GET /repos` lists them. */
  repos: PlatformRepo[];
  /** Its newest agent sessions: the repositories asked first. */
  sessions: ActivitySession[];
  /** The session or the repositories are not known yet. */
  loading: boolean;
  reposError?: string;
  onRetry: () => void;
  navigate: Navigate;
  onSignIn: () => void;
  onNew: () => void;
}) {
  const { q = '', within } = route;
  const [draft, setDraft] = useState(q);
  const box = useRef<HTMLInputElement>(null);
  // Back and Forward change the query under the box.
  useEffect(() => {
    setDraft(q);
  }, [q]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target as HTMLElement | null)) return;
      event.preventDefault();
      box.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const rows = repoRows(repos);
  const plan = searchPlan(repos, sessions);
  const signedOut = !authenticated && !loading;
  const known = authenticated && !loading && !reposError;
  const targets = within ? [within] : known ? plan.repos : null;
  const asking = q.length >= MIN_QUERY && (within || !signedOut) ? q : '';
  const { outcomes, retry } = useSearchAcross(asking, targets);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    if (next === q) retry();
    else navigate(searchRoute(next, within));
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setDraft('');
    if (q) navigate(searchRoute('', within));
  };
  const names = new Map(rows.map((r) => [r.repo, r.name]));
  const elsewhere = within && !names.has(within);
  return (
    <section className="search-page" aria-label="Search">
      <search>
        <form className="search-bar" onSubmit={submit}>
          <span className="search-box">
            <Search size={16} aria-hidden="true" />
            <input
              ref={box}
              type="search"
              aria-label="Search"
              placeholder="Search..."
              enterKeyHint="search"
              maxLength={200}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={keys}
            />
          </span>
          <select
            aria-label="Repository"
            value={within ?? ''}
            onChange={(event) =>
              navigate(searchRoute(draft.trim(), event.target.value || undefined))
            }
          >
            <option value="">All repositories</option>
            {elsewhere && <option value={within}>{repoNameOf(within)?.name ?? within}</option>}
            {rows.map((row) => (
              <option key={row.repo} value={row.repo}>
                {row.name}
              </option>
            ))}
          </select>
        </form>
      </search>
      {!q ? (
        <Welcome onSignIn={signedOut && !within ? onSignIn : undefined} />
      ) : q.length < MIN_QUERY ? (
        <p className="source-empty">Type at least {MIN_QUERY} characters to search.</p>
      ) : targets === null ? (
        signedOut ? (
          <Welcome onSignIn={onSignIn} />
        ) : reposError ? (
          <Failure error={reposError} what="your repositories" onRetry={onRetry} />
        ) : (
          <Loading what="your repositories" />
        )
      ) : !targets.length ? (
        <div className="source-empty-state">
          <p>You have no repositories to search yet.</p>
          <button type="button" onClick={onNew}>
            New repository
          </button>
        </div>
      ) : (
        <SearchResults
          query={q}
          within={within}
          targets={targets}
          capped={plan.capped}
          outcomes={outcomes}
          names={names}
          navigate={navigate}
          onRetry={retry}
        />
      )}
    </section>
  );
}
