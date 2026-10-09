import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { api } from '../../lib/api';
import { ExecutionFailure } from './ExecutionFailure';

type Entry = {
  seq: number;
  at: number;
  data: {
    stage: string;
    job_id: string;
    epoch: number;
    provider: string;
    model: string;
    http_status?: number;
    duration_ms?: number;
    request_number?: number;
    error_code?: string;
  };
};
type Page = { entries: Entry[]; next: number; has_more: boolean };
const labels: Record<string, string> = {
  'execution.started': 'Execution claimed',
  'model.request_started': 'Request sent to provider',
  'model.response_headers': 'Provider response received',
  'model.rejected': 'Request blocked before inference',
  'model.transport_failed': 'Provider connection failed',
  'execution.completion_received': 'Completion received',
  'execution.failure_received': 'Failure received',
};

export default function LogDialog({
  repo,
  execution,
  onClose,
  onProviders,
}: {
  repo: string;
  execution: Record<string, any>;
  onClose: () => void;
  onProviders?: () => void;
}) {
  const [page, setPage] = useState<Page>({ entries: [], next: 0, has_more: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const path = `repos/${repo}/execution_logs?execution_id=${encodeURIComponent(execution.id)}`;
  useEffect(() => {
    alive.current = true;
    void api<Page>(path)
      .then((result) => {
        if (alive.current) setPage(result);
      })
      .catch(() => {
        if (alive.current) setError('Could not load logs. Try again.');
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
  }, [path]);
  async function more() {
    setLoading(true);
    setError('');
    try {
      const result = await api<Page>(`${path}&after=${page.next}`);
      if (alive.current)
        setPage((previous) => ({ ...result, entries: [...previous.entries, ...result.entries] }));
    } catch {
      if (alive.current) setError('Could not load logs. Try again.');
    } finally {
      if (alive.current) setLoading(false);
    }
  }
  const route = execution.routing;
  return (
    <Dialog title="Agent logs" wide onClose={onClose}>
      <div className="execution-log-meta">
        <strong>{execution.model ?? execution.harness}</strong>
        <span>
          {route?.plan === 'token_plan'
            ? `Token Plan · ${route.region?.toUpperCase()}`
            : execution.provider === 'zai'
              ? 'Coding Plan'
              : 'API credits'}{' '}
          · {execution.status}
        </span>
        <code>{execution.id}</code>
      </div>
      {execution.status === 'failed' && (
        <ExecutionFailure repo={repo} execution={execution} onProviders={onProviders} />
      )}
      <div className="execution-log-heading">
        <h3>Request timeline</h3>
        <button type="button" className="quiet" onClick={() => void more()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : undefined} />
          {loading ? 'Loading…' : page.has_more ? 'Load more' : 'Refresh logs'}
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!page.entries.length && !loading && !error && (
        <p className="inline-empty">
          No request logs recorded. Detailed timelines are available for attempts started after this
          update.
        </p>
      )}
      <ol className="execution-log-list" aria-label="Request timeline" aria-busy={loading}>
        {page.entries.map((entry) => (
          <li key={entry.seq} className={entry.data.error_code ? 'log-error' : ''}>
            <time dateTime={new Date(entry.at).toISOString()}>
              {new Date(entry.at).toLocaleTimeString()}
            </time>
            <div>
              <strong>{labels[entry.data.stage] ?? entry.data.stage}</strong>
              <small>
                Attempt {entry.data.epoch}
                {entry.data.request_number !== undefined &&
                  ` · request ${entry.data.request_number}`}
                {entry.data.http_status !== undefined && ` · HTTP ${entry.data.http_status}`}
                {entry.data.duration_ms !== undefined &&
                  ` · ${(entry.data.duration_ms / 1000).toFixed(2)}s${entry.data.stage === 'model.response_headers' ? ' to headers' : ''}`}
              </small>
              {entry.data.error_code && <code>{entry.data.error_code}</code>}
            </div>
          </li>
        ))}
      </ol>
      <p className="subtle">
        Logs retain status and timing. API keys, prompts and provider response bodies are excluded.
      </p>
    </Dialog>
  );
}
