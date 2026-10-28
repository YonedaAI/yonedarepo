import { CommitDiff } from './CommitDiff';
import type { CommitDetail } from './CommitGates';
import { CommitLanding } from './CommitLanding';
import { CommitRepairs } from './CommitRepairs';
import { CommitSessions } from './CommitSessions';
import type { RepoStatus } from './repoStatus';
import { Failure, Loading } from './SourceStatus';
import { shortSha, when } from './sourceApi';
import type { SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

export function CommitView({
  repo,
  commit,
  status,
  username,
  onNavigate,
  onChanged,
}: {
  repo: string;
  commit: string;
  /** The signed-in account's username. */
  username?: string;
  /** The repository's status: the viewer's role, the policy and the branches. */
  status?: RepoStatus;
  onNavigate: (r: SourceRoute) => void;
  onChanged: () => void;
}) {
  const detail = useSource<CommitDetail>(`/repos/${repo}/commits/${commit}`);
  if (detail.error) return <Failure error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Loading what="commit" />;
  const d = detail.data;
  return (
    <article className="source-commit" aria-label={`Commit ${shortSha(d.commit)}`}>
      <header>
        <h2>{d.message.split('\n')[0]}</h2>
        <p className="source-meta">
          <code>{d.commit}</code> by {d.principal}
          {d.parents.map((p) => (
            <span key={p}>
              {' · parent '}
              <a
                href={`/source/${repo}/commit/${p}`}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate({ view: 'commit', repo, commit: p });
                }}
              >
                <code>{shortSha(p)}</code>
              </a>
            </span>
          ))}
        </p>
        {d.read_set.length > 0 && (
          <p className="source-meta">Declared read set: {d.read_set.join(', ')}</p>
        )}
      </header>
      <CommitLanding
        repo={repo}
        detail={d}
        status={status}
        username={username}
        onNavigate={onNavigate}
        onReload={() => {
          detail.reload();
          onChanged();
        }}
      />
      <section aria-label="Checks">
        <h3>Checks</h3>
        {d.checks.length === 0 && d.check_runs.length === 0 && (
          <p className="source-empty">No checks recorded.</p>
        )}
        <ul className="source-checks">
          {d.checks.map((c) => (
            <li key={c.name} className={`source-check-${c.status}`}>
              {c.name}: {c.status} · {c.principal} · {when(c.recorded_at)}
            </li>
          ))}
          {d.check_runs
            .filter(
              (r) => r.status === 'queued' || r.status === 'running' || r.status === 'errored',
            )
            .map((r) => (
              <li key={r.id}>
                {r.name}: run {r.status}
                {r.epoch > 0 && ` (attempt ${r.epoch})`}
              </li>
            ))}
        </ul>
      </section>
      <CommitRepairs repo={repo} repairs={d.repairs} onNavigate={onNavigate} />
      <CommitSessions repo={repo} commit={commit} navigate={onNavigate} />
      <section aria-label="Reviews">
        <h3>Reviews</h3>
        {d.reviews.length === 0 && <p className="source-empty">No reviews yet.</p>}
        <ul>
          {d.reviews.map((r) => (
            <li key={r.principal}>
              {r.principal}: {r.decision}
              {r.reason && ` — ${r.reason}`} · {when(r.recorded_at)}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Changes">
        <h3>Changes</h3>
        <CommitDiff
          repo={repo}
          commit={commit}
          classes={Object.fromEntries(
            (d.review_classes?.files ?? []).map((f) => [f.path, f.class]),
          )}
        />
      </section>
    </article>
  );
}
