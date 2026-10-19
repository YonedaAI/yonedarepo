import { useCallback, useEffect, useState } from 'react';
import { CommitView } from './CommitView';
import { RepoFiles } from './RepoFiles';
import { RepoHistory } from './RepoHistory';
import { RepoList } from './RepoList';
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
  }>(repo ? `/repos/${repo}` : null);
  const tab = (view: 'files' | 'history' | 'transactions', label: string) =>
    repo && (
      <a
        href={formatSourceRoute(
          view === 'files'
            ? { view, repo, path: '', ref: 'main' }
            : view === 'history'
              ? { view, repo, ref: 'main' }
              : { view, repo },
        )}
        aria-current={route.view === view ? 'page' : undefined}
        onClick={(e) => {
          e.preventDefault();
          navigate(
            view === 'files'
              ? { view, repo, path: '', ref: 'main' }
              : view === 'history'
                ? { view, repo, ref: 'main' }
                : { view, repo },
          );
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
                files, history and the transaction log.
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
              {status.error && (
                <Failure
                  error={unauthorized ? 'Sign in from the workspace first.' : status.error}
                  onRetry={status.reload}
                />
              )}
              <nav className="source-tabs" aria-label="Repository">
                {tab('files', 'Files')}
                {tab('history', 'History')}
                {tab('transactions', 'Transactions')}
              </nav>
            </>
          )}
          {route.view === 'files' && <RepoFiles route={route} onNavigate={navigate} />}
          {route.view === 'history' && (
            <RepoHistory repo={route.repo} refName={route.ref} onNavigate={navigate} />
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
