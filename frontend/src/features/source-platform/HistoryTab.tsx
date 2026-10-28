// The History tab: a branch's commits, every landed version of the transaction log, or the
// branches and tags (managed here by the write role and above).
import { RepoBranches } from '../repo-settings/RepoBranches';
import type { Navigate } from '../shell/useRoute';
import { OpenChangeButton } from './OpenChange';
import { RepoHistory } from './RepoHistory';
import { RepoTransactions } from './RepoTransactions';
import { useReadOnly } from './repoAccess';
import { canMoveBranches, type RepoStatus } from './repoStatus';
import type { SourceRoute } from './sourceRoute';

type Route = Extract<SourceRoute, { view: 'history' | 'transactions' | 'branches' }>;

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
  const readOnly = useReadOnly();
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
          {toggle('branches', 'Branches and tags', { view: 'branches', repo: route.repo })}
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
        {segment === 'history' && !readOnly && (
          <OpenChangeButton
            key={ref}
            repo={route.repo}
            branch={ref}
            parent={status?.parent?.repo}
            onOpened={(change, repo) => navigate({ view: 'change', repo, number: change.number })}
          />
        )}
      </div>
      {route.view === 'history' && (
        <RepoHistory repo={route.repo} refName={route.ref} onNavigate={navigate} />
      )}
      {route.view === 'transactions' && (
        <RepoTransactions repo={route.repo} onNavigate={navigate} />
      )}
      {route.view === 'branches' && (
        <RepoBranches repo={route.repo} canWrite={canMoveBranches(status?.viewer)} />
      )}
    </section>
  );
}
