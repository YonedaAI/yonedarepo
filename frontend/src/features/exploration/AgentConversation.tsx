import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../lib/types';
import { ConversationRecords } from './ConversationRecords';
import { type ConversationPage, conversationPager } from './conversationPager';
import '../../styles/agent-conversation.css';

export function AgentConversation({
  snapshot,
  run,
  onContext,
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
  onContext: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const [generation, setGeneration] = useState(0);
  return (
    <section className="agent-conversation" aria-label="Agent conversation">
      <h3>Agent conversation</h3>
      <p>Read the actual contracts, questions, findings and blockers exchanged during this run.</p>
      {!opened ? (
        <button type="button" className="quiet" onClick={() => setOpened(true)}>
          Show agent conversation
        </button>
      ) : (
        <>
          <button
            type="button"
            className="text-button"
            onClick={() => setGeneration((value) => value + 1)}
          >
            Refresh conversation
          </button>
          <ConversationFeed
            key={`${snapshot.repository.id}:${run.id}:${generation}`}
            snapshot={snapshot}
            run={run}
            onContext={onContext}
          />
        </>
      )}
    </section>
  );
}

function ConversationFeed({
  snapshot,
  run,
  onContext,
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
  onContext: () => void;
}) {
  const [pager] = useState(() => conversationPager(snapshot.repository.id, run.id));
  const [page, setPage] = useState<ConversationPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const current = useRef(true);
  const pending = useRef(false);
  const load = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    setError('');
    try {
      const value = await pager.load();
      if (current.current) setPage(value);
    } catch (failure) {
      if (current.current) setError((failure as Error).message);
    } finally {
      pending.current = false;
      if (current.current) setLoading(false);
    }
  }, [pager]);
  useEffect(() => {
    current.current = true;
    void load();
    return () => {
      current.current = false;
    };
  }, [load]);
  return (
    <>
      {loading && <p role="status">Loading conversation…</p>}
      {error && (
        <p role="alert">
          Could not read conversation: {error}{' '}
          <button
            type="button"
            className="text-button"
            disabled={loading}
            onClick={() => void load()}
          >
            Retry conversation
          </button>
        </p>
      )}
      {page && (
        <>
          {!page.items.length && <p>No agent messages are recorded in this conversation page.</p>}
          {!!page.items.length && (
            <ConversationRecords
              items={page.items}
              snapshot={snapshot}
              run={run}
              onContext={onContext}
            />
          )}
          <p className="subtle">
            This view keeps a fixed message boundary. Refresh to include newer messages.
          </p>
          {page.has_more && (
            <button type="button" className="quiet" disabled={loading} onClick={() => void load()}>
              Load next messages
            </button>
          )}
        </>
      )}
    </>
  );
}
