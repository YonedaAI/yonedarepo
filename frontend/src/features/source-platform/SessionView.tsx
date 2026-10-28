// One recorded session: what the agent said it did, the commit it produced, the reads that
// commit declared and the session's other commits. Transcripts are not on the platform; a
// reference names where one is kept (linked when it is a web address).
import { ArrowLeft } from 'lucide-react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { recorder, type SessionDetail, transcriptUrl } from './agentModel';
import { Failure, Loading } from './SourceStatus';
import { shortSha, when } from './sourceApi';
import { useSource } from './useSource';

export function SessionView({
  repo,
  id,
  navigate,
}: {
  repo: string;
  id: number;
  navigate: Navigate;
}) {
  const loaded = useSource<SessionDetail>(`/repos/${repo}/sessions/${id}`);
  const back = (
    <a
      className="toolbar-link"
      {...linkTo({ view: 'agents', repo, section: 'sessions' }, navigate)}
    >
      <ArrowLeft size={14} aria-hidden="true" /> All sessions
    </a>
  );
  if (loaded.loading && !loaded.data) return <Loading what="the session" />;
  if (loaded.error)
    return (
      <>
        {back}
        <Failure error={loaded.error} onRetry={loaded.reload} />
      </>
    );
  const { session: s, commit, reads, reads_truncated, related } = loaded.data as SessionDetail;
  const transcript = transcriptUrl(s.transcript_ref);
  const commitLink = (sha: string, text: string) => (
    <a {...linkTo({ view: 'commit', repo, commit: sha }, navigate)}>
      <code>{shortSha(sha)}</code> {text}
    </a>
  );
  return (
    <article className="agent-session" aria-labelledby="session-title">
      {back}
      <h2 id="session-title">
        <span className="chip">{s.cli}</span> {s.model ?? 'model not recorded'}
      </h2>
      <p className="source-session-summary">{s.summary}</p>
      <dl className="agent-facts">
        <dt>Recorded by</dt>
        <dd>
          {recorder(s.recorded_by)} · {when(s.at)}
        </dd>
        <dt>Commit</dt>
        <dd>
          {commitLink(commit.id, commit.message.split('\n')[0])} · pushed by{' '}
          {recorder(commit.principal)}
        </dd>
        <dt>Transcript</dt>
        <dd>
          {transcript ? (
            <a href={transcript} target="_blank" rel="noreferrer noopener">
              {s.transcript_ref}
            </a>
          ) : s.transcript_ref ? (
            <code>{s.transcript_ref}</code>
          ) : (
            'not recorded'
          )}
        </dd>
        {s.prompt_digest && (
          <>
            <dt>Prompts digest</dt>
            <dd>
              <code>{s.prompt_digest}</code>
            </dd>
          </>
        )}
        {s.read_set_digest && (
          <>
            <dt>Read-set digest</dt>
            <dd>
              <code>{s.read_set_digest}</code>
            </dd>
          </>
        )}
      </dl>
      <section aria-labelledby="session-reads-heading">
        <h3 id="session-reads-heading">Files read ({s.reads})</h3>
        {reads.length === 0 ? (
          <p className="source-empty">The commit declared no reads.</p>
        ) : (
          <ul className="agent-reads">
            {reads.map((r) => (
              <li key={r}>
                <code>{r}</code>
              </li>
            ))}
          </ul>
        )}
        {reads_truncated && <p className="source-meta">Showing the first {reads.length}.</p>}
      </section>
      <section aria-labelledby="session-related-heading">
        <h3 id="session-related-heading">Other commits from this session</h3>
        {related.length === 0 ? (
          <p className="source-empty">None recorded.</p>
        ) : (
          <ul className="agent-related">
            {related.map((r) => (
              <li key={r.id}>
                {commitLink(r.commit, r.subject)} ·{' '}
                <a {...linkTo({ view: 'session', repo, id: r.id }, navigate)}>record #{r.id}</a> ·{' '}
                {when(r.at)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
