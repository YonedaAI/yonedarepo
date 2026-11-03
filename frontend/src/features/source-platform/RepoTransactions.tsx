import { usePeople } from './people';
import { Failure, Loading } from './SourceStatus';
import { shortSha, when } from './sourceApi';
import { formatSourceRoute, type SourceRoute } from './sourceRoute';
import { useVersions } from './useVersions';

type Entry = {
  version: number;
  kind: string;
  refname: string;
  new?: string;
  actor: string;
  paths: { path: string; op: string }[];
  committed_at_ms: number;
  chain: string;
};

/** The hash-chained transaction log: every ref move, in order. */
export function RepoTransactions({
  repo,
  onNavigate,
  recent,
  known,
}: {
  repo: string;
  onNavigate: (r: SourceRoute) => void;
  recent?: boolean;
  known?: number;
}) {
  const people = usePeople();
  const log = useVersions(repo, recent, known);
  if (log.error) return <Failure error={log.error} onRetry={log.reload} />;
  if (!log.page) return <Loading what="versions" />;
  if (log.page.entries.length === 0) return <p className="source-empty">The log is empty.</p>;
  return (
    <div className="source-table-wrap">
      <table className="source-table">
        <caption>Transaction log (version {log.page.version})</caption>
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Kind</th>
            <th scope="col">Ref</th>
            <th scope="col">Commit</th>
            <th scope="col" className="num">
              Paths
            </th>
            <th scope="col">Actor</th>
            <th scope="col">When</th>
            <th scope="col">Chain</th>
          </tr>
        </thead>
        <tbody>
          {(log.page.entries as Entry[]).map((e) => (
            <tr key={e.version}>
              <td>
                <a
                  href={formatSourceRoute({
                    view: 'files',
                    repo,
                    path: '',
                    ref: e.refname.replace(/^refs\/heads\//, ''),
                    at: e.version,
                  })}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate({
                      view: 'files',
                      repo,
                      path: '',
                      ref: e.refname.replace(/^refs\/heads\//, ''),
                      at: e.version,
                    });
                  }}
                >
                  v{e.version}
                </a>
              </td>
              <td>{e.kind}</td>
              <td>{e.refname.replace(/^refs\/heads\//, '')}</td>
              <td>
                {e.new && (
                  <a
                    href={formatSourceRoute({ view: 'commit', repo, commit: e.new })}
                    onClick={(event) => {
                      event.preventDefault();
                      onNavigate({ view: 'commit', repo, commit: e.new as string });
                    }}
                  >
                    <code>{shortSha(e.new)}</code>
                  </a>
                )}
              </td>
              <td className="num" title={e.paths.map((p) => `${p.op} ${p.path}`).join('\n')}>
                {e.paths.length}
              </td>
              <td>
                {e.actor.startsWith('break-glass:') && (
                  <span className="source-badge-danger">Break-glass</span>
                )}{' '}
                {people.principal(e.actor.replace(/^break-glass:/, ''))}
              </td>
              <td>{when(e.committed_at_ms)}</td>
              <td>
                <code title={e.chain}>{e.chain.slice(0, 8)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {log.newer.length > 0 && (
        <button type="button" className="quiet" disabled={log.loading} onClick={log.loadNewer}>
          Newer
        </button>
      )}
      {log.page.next_before && (
        <button type="button" className="quiet" disabled={log.loading} onClick={log.loadOlder}>
          {log.loading ? 'Loading…' : 'Load older'}
        </button>
      )}
    </div>
  );
}
