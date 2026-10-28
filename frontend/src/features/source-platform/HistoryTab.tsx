// The History tab: a branch's commits, or every landed version of the transaction log; for a
// repository with an agent project, its recorded agent context too.
import { type ReactNode, useState } from 'react';
import type { Navigate } from '../shell/useRoute';
import { RepoHistory } from './RepoHistory';
import { RepoTransactions } from './RepoTransactions';
import type { RepoStatus } from './repoStatus';
import type { SourceRoute } from './sourceRoute';

type Route = Extract<SourceRoute, { view: 'history' | 'transactions' }>;

export function HistoryTab({
  route,
  status,
  navigate,
  agentContext,
}: {
  route: Route;
  status?: RepoStatus;
  navigate: Navigate;
  /** The agent project's source history (traces, conflicts), when there is one. */
  agentContext?: ReactNode;
}) {
  const [agent, setAgent] = useState(false);
  const branches = (status?.refs ?? [])
    .filter((r) => r.name.startsWith('refs/heads/'))
    .map((r) => r.name.slice('refs/heads/'.length));
  const ref = route.view === 'history' ? route.ref : 'main';
  const segment = agent ? 'agent' : route.view;
  const toggle = (id: string, label: string, to: SourceRoute | null) => (
    <button
      key={id}
      type="button"
      aria-pressed={segment === id}
      onClick={() => {
        setAgent(!to);
        if (to) navigate(to);
      }}
    >
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
          {agentContext && toggle('agent', 'Agent context', null)}
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
      </div>
      {segment === 'agent' ? (
        agentContext
      ) : route.view === 'history' ? (
        <RepoHistory repo={route.repo} refName={route.ref} onNavigate={navigate} />
      ) : (
        <RepoTransactions repo={route.repo} onNavigate={navigate} />
      )}
    </section>
  );
}
