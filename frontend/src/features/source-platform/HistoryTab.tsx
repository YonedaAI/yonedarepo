// The History tab: a branch's commits, or every landed version of the transaction log.
import type { Navigate } from '../shell/useRoute';
import { OpenChangeButton } from './OpenChange';
import { RepoHistory } from './RepoHistory';
import { RepoTransactions } from './RepoTransactions';
import type { RepoStatus } from './repoStatus';
import type { SourceRoute } from './sourceRoute';

type Route = Extract<SourceRoute, { view: 'history' | 'transactions' }>;

export function HistoryTab({
  route,
  status,
  navigate,
}: {
  route: Route;
  status?: RepoStatus;
  navigate: Navigate;
}) {
  const branches = (status?.refs ?? [])
    .filter((r) => r.name.startsWith('refs/heads/'))
    .map((r) => r.name.slice('refs/heads/'.length));
  const ref = route.view === 'history' ? route.ref : 'main';
  const segment = route.view;
  const toggle = (id: string, label: string, to: SourceRoute) => (
    <button key={id} type="button" aria-pressed={segment === id} onClick={() => navigate(to)}>
      {label}
    </button>
  );
  return (
    <section aria-label="History">
      <div className="source-toolbar">
        <fieldset className="segmented">
          <legend className="sr-only">Show</legend>
          {toggle('history', 'Commits', { view: 'history', repo: route.repo, ref })}
          {toggle('transactions', 'Landed versions', { view: 'transactions', repo: route.repo })}
        </fieldset>
        {segment === 'history' && branches.length > 1 && (
          <label className="source-version">
            Branch
            <select
              value={ref}
              onChange={(e) => navigate({ view: 'history', repo: route.repo, ref: e.target.value })}
            >
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
        )}
        {segment === 'history' && (
          <OpenChangeButton
            key={ref}
            repo={route.repo}
            branch={ref}
            onOpened={(change) =>
              navigate({ view: 'change', repo: route.repo, number: change.number })
            }
          />
        )}
      </div>
      {route.view === 'history' ? (
        <RepoHistory repo={route.repo} refName={route.ref} onNavigate={navigate} />
      ) : (
        <RepoTransactions repo={route.repo} onNavigate={navigate} />
      )}
    </section>
  );
}
