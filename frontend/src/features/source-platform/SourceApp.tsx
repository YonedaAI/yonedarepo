import { useCallback, useEffect, useState } from 'react';
import { CommitView } from './CommitView';
import { RepoFiles } from './RepoFiles';
import { RepoHistory } from './RepoHistory';
import { RepoList } from './RepoList';
import { RepoOverview } from './RepoOverview';
import { RepoSearch } from './RepoSearch';
import { RepoTransactions } from './RepoTransactions';
import { Failure } from './SourceStatus';
import { formatSourceRoute, parseSourceRoute, type SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

const current = () => parseSourceRoute(window.location.pathname, window.location.search);

/** YonedaRepo source platform: repositories, files, history, review and landing. */
export function SourceApp() {
  const [route, setRoute] = useState<SourceRoute>(current);
  useEffect(() => {
    const sync = () => setRoute(current());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const navigate = useCallback((next: SourceRoute) => {
    window.history.pushState(null, '', formatSourceRoute(next));
    setRoute(next);
    window.scrollTo({ top: 0 });
  }, []);
  const repo = route.view === 'repos' ? undefined : route.repo;
  const status = useSource<{
    name: string;
    version: number;
    policy: { required_checks: string[]; approvals: number };
    projections?: { refname: string; status: string; detail?: string }[];
  }>(repo ? `/repos/${repo}` : null);
  const drift = status.data?.projections?.filter((p) => p.status === 'drift') ?? [];
  type Tab = 'files' | 'overview' | 'history' | 'transactions' | 'search';
  const entry = (view: Tab, repo: string): SourceRoute =>
    view === 'files' || view === 'overview'
      ? { view, repo, path: '', ref: 'main' }
      : view === 'history'
        ? { view, repo, ref: 'main' }
        : view === 'search'
          ? { view, repo, query: '' }
          : { view, repo };
  const tab = (view: Tab, label: string) =>
    repo && (
      <a
        href={formatSourceRoute(entry(view, repo))}
        aria-current={route.view === view ? 'page' : undefined}
        onClick={(e) => {
          e.preventDefault();
          navigate(entry(view, repo));
        }}
      >
        {label}
      </a>
    );
  const unauthorized = status.error?.includes('Sign in');
  return (
    <div className="source-app">
      <header className="source-header">
        <a
          href="/source"
          onClick={(e) => {
            e.preventDefault();
            navigate({ view: 'repos' });
          }}
        >
          <strong>YonedaRepo</strong> source
        </a>
        <a href="/">Workspace</a>
      </header>
      <div className="source-body">
        <RepoList selected={repo} onNavigate={navigate} />
        <main className="source-main" id="source-main">
          {route.view === 'repos' && (
            <div className="source-welcome">
              <h1>Source platform</h1>
              <p>
                Git semantics over an API: commits are made on the server, checked on the exact
                commit, reviewed and landed with optimistic concurrency. Pick a repository to browse
                files, a generated overview, history and the transaction log.
              </p>
            </div>
          )}
          {repo && (
            <>
              <div className="source-repo-head">
                <h1>{status.data?.name ?? repo}</h1>
                {status.data && (
                  <span className="source-meta">
                    log v{status.data.version} · needs {status.data.policy.approvals} approval(s)
                    {status.data.policy.required_checks.length > 0 &&
                      ` and ${status.data.policy.required_checks.join(', ')}`}
                  </span>
                )}
              </div>
              {drift.map((p) => (
                <p key={p.refname} role="alert" className="source-error">
                  {p.refname.replace(/^refs\/heads\//, '')} in the Git object store has drifted from
                  the landed branch and is no longer updated: {p.detail}
                </p>
              ))}
              {status.error && (
                <Failure
                  error={unauthorized ? 'Sign in from the workspace first.' : status.error}
                  onRetry={status.reload}
                />
              )}
              <nav className="source-tabs" aria-label="Repository">
                {tab('files', 'Files')}
                {tab('overview', 'Overview')}
                {tab('history', 'History')}
                {tab('transactions', 'Transactions')}
                {tab('search', 'Search')}
              </nav>
            </>
          )}
          {route.view === 'files' && <RepoFiles route={route} onNavigate={navigate} />}
          {route.view === 'overview' && <RepoOverview route={route} onNavigate={navigate} />}
          {route.view === 'history' && (
            <RepoHistory repo={route.repo} refName={route.ref} onNavigate={navigate} />
          )}
          {route.view === 'search' && (
            <RepoSearch
              key={route.query}
              repo={route.repo}
              query={route.query}
              onNavigate={navigate}
            />
          )}
          {route.view === 'transactions' && (
            <RepoTransactions repo={route.repo} onNavigate={navigate} />
          )}
          {route.view === 'commit' && (
            <CommitView
              key={route.commit}
              repo={route.repo}
              commit={route.commit}
              onNavigate={navigate}
              onChanged={status.reload}
            />
          )}
        </main>
      </div>
    </div>
  );
}
