import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import {
  activityLabels,
  ago,
  type SandboxActivityEntry,
  type SandboxActivityPage,
} from './sandboxActivityView';

const REFRESH_MS = 5000;

/** The coding CLI's own activity (tool calls, edits, replies), newest last. */
export function SandboxActivity({
  repo,
  execution,
}: {
  repo: string;
  execution: Record<string, any>;
}) {
  const [entries, setEntries] = useState<SandboxActivityEntry[]>([]);
  const [page, setPage] = useState<Omit<SandboxActivityPage, 'entries'> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const next = useRef(0);
  const alive = useRef(true);
  const live = ['queued', 'running'].includes(execution.status);
  const path = `repos/${repo}/sandbox_activity?execution_id=${encodeURIComponent(execution.id)}`;

  const busy = useRef(false);
  const load = useCallback(async () => {
    // One reader at a time, so a timer tick and a click never append the same page twice.
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      // Follow every page so the newest activity is always shown.
      for (;;) {
        const result = await api<SandboxActivityPage>(`${path}&after=${next.current}`);
        if (!alive.current) return;
        next.current = result.next;
        setEntries((previous) => [...previous, ...result.entries]);
        setPage(result);
        setError('');
        if (!result.has_more) break;
      }
    } catch {
      if (alive.current) setError('Could not load activity. Try again.');
    } finally {
      busy.current = false;
      if (alive.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    next.current = 0;
    setEntries([]);
    void load();
    const timer = live ? setInterval(() => void load(), REFRESH_MS) : undefined;
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
  }, [load, live]);

  return (
    <>
      <div className="execution-log-heading">
        <h3>Agent activity</h3>
        <button type="button" className="quiet" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : undefined} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {page?.phase && (
        <p className="subtle" role="status">
          Sandbox {page.phase}
          {page.last_activity_at ? ` · last output ${ago(Date.now() - page.last_activity_at)}` : ''}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!entries.length && !loading && !error && (
        <p className="inline-empty">No agent activity yet. The sandbox is starting.</p>
      )}
      <ol className="execution-log-list" aria-label="Agent activity" aria-busy={loading}>
        {entries.map((entry) => (
          <li
            key={entry.seq}
            className={['tool_error', 'error'].includes(entry.kind) ? 'log-error' : ''}
          >
            <time dateTime={new Date(entry.at).toISOString()}>
              {new Date(entry.at).toLocaleTimeString()}
            </time>
            <div>
              <strong>{activityLabels[entry.kind] ?? entry.kind}</strong>
              <small>{entry.text}</small>
            </div>
          </li>
        ))}
      </ol>
      <p className="subtle">
        Activity is the coding CLI's own event stream, shortened and redacted. Keys never enter the
        sandbox.
      </p>
    </>
  );
}
