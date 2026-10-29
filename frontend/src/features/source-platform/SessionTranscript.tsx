// A session's stored transcript as readable turns: the context packet it started with,
// then the person's prompts, the agent's tool calls (collapsed, named by the file or command
// they acted on) and its replies. Credentials were redacted by the platform before storing.
import {
  type SessionRecord,
  type StoredTranscript,
  type TranscriptTurn,
  toolLabel,
  transcriptNotes,
  transcriptPath,
} from './agentModel';
import { Markdown } from './markdown';
import { Failure, Loading } from './SourceStatus';
import { useSource } from './useSource';

function Turn({ turn }: { turn: TranscriptTurn }) {
  switch (turn.kind) {
    case 'prompt':
      return (
        <li className="agent-turn agent-turn-prompt">
          <span className="agent-turn-role">Prompt</span>
          <p className="agent-turn-text">{turn.text}</p>
        </li>
      );
    case 'reply':
      return (
        <li className="agent-turn agent-turn-reply">
          <span className="agent-turn-role">Reply</span>
          <div className="agent-turn-text">
            <Markdown source={turn.text} />
          </div>
        </li>
      );
    case 'tool':
      return (
        <li className="agent-turn agent-turn-tool">
          <details>
            <summary>
              <code>{toolLabel(turn)}</code>
              {turn.error && <span className="chip agent-turn-failed">failed</span>}
            </summary>
            {turn.input && (
              <>
                <h4>Input</h4>
                <pre>{turn.input}</pre>
              </>
            )}
            {turn.output && (
              <>
                <h4>Output</h4>
                <pre>{turn.output}</pre>
              </>
            )}
            {!turn.input && !turn.output && <p className="source-meta">No input or output.</p>}
          </details>
        </li>
      );
    case 'omitted':
      return (
        <li className="agent-turn agent-turn-omitted source-meta">
          {turn.turns} turn{turn.turns === 1 ? '' : 's'} left out here to fit the size cap.
        </li>
      );
  }
}

export function SessionTranscript({ repo, session }: { repo: string; session: SessionRecord }) {
  const meta = session.transcript;
  const loaded = useSource<StoredTranscript>(meta ? transcriptPath(repo, session.id) : null);
  return (
    <section className="agent-transcript" aria-labelledby="session-transcript-heading">
      <h3 id="session-transcript-heading">Transcript</h3>
      {!meta ? (
        <p className="source-empty">
          No transcript was recorded for this session. The Yoneda plugins for Claude Code and
          opencode upload one with each record; from any other agent,{' '}
          <code>yoneda session record --transcript &lt;file&gt;</code>.
        </p>
      ) : loaded.loading && !loaded.data ? (
        <Loading what="the transcript" />
      ) : loaded.error ? (
        <Failure error={loaded.error} onRetry={loaded.reload} />
      ) : (
        <Document stored={loaded.data as StoredTranscript} />
      )}
    </section>
  );
}

function Document({ stored }: { stored: StoredTranscript }) {
  const { context, turns } = stored.document;
  if (!context && turns.length === 0)
    return <p className="source-empty">The transcript is empty.</p>;
  return (
    <>
      {transcriptNotes(stored.transcript).map((note) => (
        <p key={note} className="source-meta">
          {note}
        </p>
      ))}
      {context ? (
        <details className="agent-transcript-context">
          <summary>Context given at session start</summary>
          <pre>{context}</pre>
        </details>
      ) : (
        <p className="source-meta">No context packet was recorded at session start.</p>
      )}
      <ol className="agent-turns">
        {turns.map((turn, n) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional turns of one immutable document.
          <Turn key={n} turn={turn} />
        ))}
      </ol>
    </>
  );
}
