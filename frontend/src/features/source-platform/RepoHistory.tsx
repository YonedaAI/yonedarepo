import { usePeople } from './people';
import { Failure, Loading } from './SourceStatus';
import { shortSha, when } from './sourceApi';
import { formatSourceRoute, type SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

type LogCommit = {
  commit: string;
  message: string;
  principal: string;
  landed?: { version: number; landed_at: number };
  break_glass?: string | null;
};

export function RepoHistory({
  repo,
  refName,
  onNavigate,
}: {
  repo: string;
  refName: string;
  onNavigate: (r: SourceRoute) => void;
}) {
  const people = usePeople();
  const log = useSource<{ commits: LogCommit[]; version: number }>(
    `/repos/${repo}/log?ref=${encodeURIComponent(refName)}&limit=100`,
  );
  if (log.error) return <Failure error={log.error} onRetry={log.reload} />;
  if (!log.data) return <Loading what="history" />;
  if (log.data.commits.length === 0)
    return <p className="source-empty">No commits on {refName}.</p>;
  return (
    <ol className="source-history" aria-label={`History of ${refName}`}>
      {log.data.commits.map((c) => (
        <li key={c.commit}>
          <a
            href={formatSourceRoute({ view: 'commit', repo, commit: c.commit })}
            onClick={(e) => {
              e.preventDefault();
              onNavigate({ view: 'commit', repo, commit: c.commit });
            }}
          >
            <strong>{c.message.split('\n')[0]}</strong>
          </a>
          <span>
            <code>{shortSha(c.commit)}</code> · {people.principal(c.principal)}
            {c.landed && ` · landed v${c.landed.version} · ${when(c.landed.landed_at)}`}
            {c.break_glass && (
              <>
                {' · '}
                <span className="source-badge-danger">Break-glass {c.break_glass}</span>
              </>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
