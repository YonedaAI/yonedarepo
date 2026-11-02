import { commitDays, filesLabel, type LogCommit } from './commitLog';
import { Person } from './Person';
import { Failure, Loading } from './SourceStatus';
import { shortSha } from './sourceApi';
import { formatSourceRoute, type SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

const LOG_PAGE = 100;

export function RepoHistory({
  repo,
  refName,
  onNavigate,
}: {
  repo: string;
  refName: string;
  onNavigate: (r: SourceRoute) => void;
}) {
  const log = useSource<{ commits: LogCommit[]; version: number }>(
    `/repos/${repo}/log?ref=${encodeURIComponent(refName)}&limit=${LOG_PAGE}`,
  );
  if (log.error) return <Failure error={log.error} onRetry={log.reload} />;
  if (!log.data) return <Loading what="history" />;
  if (log.data.commits.length === 0)
    return <p className="source-empty">No commits on {refName}.</p>;
  return (
    <div className="source-history">
      {commitDays(log.data.commits, LOG_PAGE).map(({ day, count, commits }) => (
        <section key={day} aria-label={`Commits on ${day}`}>
          <h3>
            {day}
            <span>{count}</span>
          </h3>
          <ol>
            {commits.map((c) => (
              <li key={c.commit}>
                <div>
                  <a
                    href={formatSourceRoute({ view: 'commit', repo, commit: c.commit })}
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigate({ view: 'commit', repo, commit: c.commit });
                    }}
                  >
                    {c.message.split('\n')[0]}
                  </a>
                  <span>
                    {c.author_name ?? <Person principal={c.principal} />}
                    {c.break_glass && (
                      <>
                        {' · '}
                        <span className="source-badge-danger">Break-glass {c.break_glass}</span>
                      </>
                    )}
                  </span>
                </div>
                <span className="source-history-end">
                  {filesLabel(c.files_changed)}
                  <code>{shortSha(c.commit)}</code>
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
