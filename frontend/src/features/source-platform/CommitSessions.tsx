import { linkTo, type Navigate } from '../shell/useRoute';
import { recorder, type SessionRecord, summaryText, transcriptLabel } from './agentModel';
import { when } from './sourceApi';
import { useSource } from './useSource';

type Listed = Omit<SessionRecord, 'commit' | 'subject' | 'reads'>;

/** One session record: CLI and model (linking to its session page), who recorded it and
 * when, its summary and where its transcript is. */
export function SessionItem({
  repo,
  session: s,
  navigate,
}: {
  repo: string;
  session: Listed;
  navigate: Navigate;
}) {
  return (
    <li>
      <a className="agent-session-ref" {...linkTo({ view: 'session', repo, id: s.id }, navigate)}>
        <strong>{s.cli}</strong>
        {s.model && ` · ${s.model}`}
      </a>{' '}
      · {recorder(s.recorded_by)} · {when(s.at)}
      <p className="source-session-summary">{summaryText(s)}</p>
      {s.transcript ? (
        <p className="source-meta">{transcriptLabel(s)}</p>
      ) : (
        s.transcript_ref && (
          <p className="source-meta">
            Transcript: <code>{s.transcript_ref}</code>
          </p>
        )
      )}
    </li>
  );
}

/** The coding sessions that produced a commit (CLI, model, summary), as their pushers
 * recorded them, each linking to its session page (with its transcript, when one was
 * stored). */
export function CommitSessions({
  repo,
  commit,
  navigate,
  heading = 'Sessions',
}: {
  repo: string;
  commit: string;
  navigate: Navigate;
  heading?: string;
}) {
  const loaded = useSource<{ sessions: Listed[] }>(`/repos/${repo}/commits/${commit}/sessions`);
  return (
    <section aria-label={heading}>
      <h3>{heading}</h3>
      {loaded.loading && !loaded.data && <p className="source-empty">Loading sessions…</p>}
      {loaded.error && <p className="source-empty">Sessions unavailable: {loaded.error}</p>}
      {loaded.data?.sessions.length === 0 && (
        <p className="source-empty">No session recorded for this commit.</p>
      )}
      <ul>
        {loaded.data?.sessions.map((s) => (
          <SessionItem key={s.id} repo={repo} session={s} navigate={navigate} />
        ))}
      </ul>
    </section>
  );
}
