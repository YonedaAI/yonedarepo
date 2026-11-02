import { Person } from './Person';
import { Failure, Loading } from './SourceStatus';
import { shortSha } from './sourceApi';
import { formatSourceRoute, type SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

type LogCommit = {
  commit: string;
  message: string;
  principal: string;
  author_name?: string | null;
  authored_at?: number | null;
  landed?: { version: number; landed_at: number };
  break_glass?: string | null;
};

const dayName = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** The list in its own order, a heading each time the day changes. */
function commitDays(commits: LogCommit[]) {
  const days: { day: string; commits: LogCommit[] }[] = [];
  for (const commit of commits) {
    const at = commit.authored_at ?? commit.landed?.landed_at;
    const day = at ? dayName(at) : 'Unknown date';
    const last = days.at(-1);
    if (last?.day === day) last.commits.push(commit);
    else days.push({ day, commits: [commit] });
  }
  return days;
}

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
    `/repos/${repo}/log?ref=${encodeURIComponent(refName)}&limit=100`,
  );
  if (log.error) return <Failure error={log.error} onRetry={log.reload} />;
  if (!log.data) return <Loading what="history" />;
  if (log.data.commits.length === 0)
    return <p className="source-empty">No commits on {refName}.</p>;
  return (
    <div className="source-history">
      {commitDays(log.data.commits).map(({ day, commits }) => (
        <section key={day} aria-label={`Commits on ${day}`}>
          <h3>{day}</h3>
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
                <code>{shortSha(c.commit)}</code>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
