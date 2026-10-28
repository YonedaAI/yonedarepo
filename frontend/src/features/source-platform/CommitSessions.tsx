import { linkTo, type Navigate } from '../shell/useRoute';
import { recorder, type SessionRecord } from './agentModel';
import { when } from './sourceApi';
import { useSource } from './useSource';

/** The coding sessions that produced a commit (CLI, model, summary), as their pushers
 * recorded them, each linking to its session page. Transcripts are not on the platform; a
 * reference names where one is. */
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
  const loaded = useSource<{ sessions: Omit<SessionRecord, 'commit' | 'subject' | 'reads'>[] }>(
    `/repos/${repo}/commits/${commit}/sessions`,
  );
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
          <li key={s.id}>
            <a
              className="agent-session-ref"
              {...linkTo({ view: 'session', repo, id: s.id }, navigate)}
            >
              <strong>{s.cli}</strong>
              {s.model && ` · ${s.model}`}
            </a>{' '}
            · {recorder(s.recorded_by)} · {when(s.at)}
            <p className="source-session-summary">{s.summary}</p>
            {s.transcript_ref && (
              <p className="source-meta">
                Transcript: <code>{s.transcript_ref}</code>
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
