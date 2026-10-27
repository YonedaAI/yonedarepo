import { when } from './sourceApi';
import { useSource } from './useSource';

type Session = {
  id: number;
  cli: string;
  model: string | null;
  summary: string;
  transcript_ref: string | null;
  read_set_digest: string | null;
  recorded_by: string;
  at: number;
};

/** The coding sessions that produced a commit (CLI, model, summary), as their pushers
 * recorded them. Transcripts are not on the platform; a reference names where one is. */
export function CommitSessions({ repo, commit }: { repo: string; commit: string }) {
  const loaded = useSource<{ sessions: Session[] }>(`/repos/${repo}/commits/${commit}/sessions`);
  return (
    <section aria-label="Sessions">
      <h3>Sessions</h3>
      {loaded.loading && !loaded.data && <p className="source-empty">Loading sessions…</p>}
      {loaded.error && <p className="source-empty">Sessions unavailable: {loaded.error}</p>}
      {loaded.data?.sessions.length === 0 && (
        <p className="source-empty">No session recorded for this commit.</p>
      )}
      <ul>
        {loaded.data?.sessions.map((s) => (
          <li key={s.id}>
            <strong>{s.cli}</strong>
            {s.model && ` · ${s.model}`} · {s.recorded_by} · {when(s.at)}
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
