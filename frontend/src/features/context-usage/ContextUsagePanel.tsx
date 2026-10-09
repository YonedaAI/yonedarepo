import { RefreshCw } from 'lucide-react';
import { useId, useState } from 'react';
import type { ContextUsage } from '../../../../shared/context_usage';
import type { Snapshot } from '../../lib/types';
import { ContextUsageRows } from './ContextUsageRows';
import { contextUsageMetric, contextUsagePath } from './contextUsageView';
import { useContextUsage } from './useContextUsage';
import '../../styles/context-usage.css';

const metrics: { key: keyof ContextUsage['counts']; label: string; detail: string }[] = [
  { key: 'assigned', label: 'Assigned', detail: 'Frozen input records' },
  { key: 'returned', label: 'Returned in search', detail: 'Distinct delivered records' },
  { key: 'opened', label: 'Opened', detail: 'Distinct retrieved records' },
  { key: 'cited', label: 'Explicitly cited', detail: 'Distinct referenced records' },
  { key: 'checked', label: 'Revision checks', detail: 'Evaluator result events' },
];

export function ContextUsagePanel({
  snapshot,
  run,
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
}) {
  const heading = useId();
  const [agent, setAgent] = useState('');
  const [epoch, setEpoch] = useState('');
  const [pages, setPages] = useState([0]);
  const cursor = pages.at(-1) ?? 0;
  const path = contextUsagePath(snapshot.repository.id, run.id, agent, epoch, cursor);
  const { data, error, loading, refresh } = useContextUsage(path, snapshot.seq);
  const labels = new Map<string, string>(
    snapshot.executions
      .filter((execution) => execution.run_id === run.id)
      .map((execution) => [
        execution.id,
        execution.strategy || execution.model || execution.role || execution.id,
      ]),
  );
  for (const entry of data?.entries ?? [])
    if (entry.execution_id && !labels.has(entry.execution_id))
      labels.set(entry.execution_id, entry.execution_id);
  for (const assignment of data?.assigned ?? [])
    if (!labels.has(assignment.execution_id))
      labels.set(assignment.execution_id, assignment.execution_id);
  if (agent && !labels.has(agent)) labels.set(agent, agent);
  return (
    <section className="context-usage" aria-labelledby={heading}>
      <div className="context-usage-heading">
        <div>
          <h2 id={heading}>Context usage</h2>
          <p>Recorded delivery, retrieval, explicit citations and revision checks.</p>
        </div>
        <button type="button" className="quiet" disabled={loading || !path} onClick={refresh}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>
      <p className="context-usage-note">
        The console projects the same scoped evidence agents query with <code>context_usage</code>.
        Records show lineage, not what an agent thought.
      </p>
      <div className="context-usage-filters">
        <label>
          Retrieval agent
          <select
            value={agent}
            onChange={(event) => {
              setAgent(event.target.value);
              setPages([0]);
            }}
          >
            <option value="">All agents and sessions</option>
            {[...labels].map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Retrieval attempt
          <input
            type="number"
            min={1}
            step={1}
            value={epoch}
            placeholder="All attempts"
            onChange={(event) => {
              setEpoch(event.target.value);
              setPages([0]);
            }}
          />
        </label>
      </div>
      {!path && <p role="alert">Enter a positive whole attempt number, or leave it blank.</p>}
      {error && (
        <p className="context-usage-error" role="alert">
          Could not load context evidence: {error}{' '}
          <button type="button" className="text-button" disabled={loading} onClick={refresh}>
            Retry
          </button>
        </p>
      )}
      {loading && (
        <p className="context-usage-note" role="status">
          {data ? 'Updating recorded evidence…' : 'Loading recorded context evidence…'}
        </p>
      )}
      {!data && !loading && !error && path && (
        <p className="context-usage-empty">Context evidence is pending.</p>
      )}
      {data && (
        <>
          <div className={`context-coverage context-coverage-${data.coverage.status}`}>
            <strong>
              {data.coverage.status === 'recorded'
                ? 'Access tracking recorded'
                : data.coverage.status === 'partial'
                  ? 'Access tracking is partial'
                  : 'Historical access tracking unavailable'}
            </strong>
            <p>
              {data.coverage.reason ||
                (data.coverage.status === 'recorded'
                  ? 'Successful scoped retrieval calls are recorded. Delivery does not prove reasoning or influence.'
                  : 'Earlier returned or opened records may be untracked. Missing events do not mean the agent read nothing.')}
            </p>
          </div>
          <dl className="context-usage-metrics">
            {metrics.map((metric) => {
              const value = contextUsageMetric(data, metric.key);
              return (
                <div key={metric.key}>
                  <dt>{metric.label}</dt>
                  <dd>{value.value}</dd>
                  <small>{metric.detail}</small>
                  <small>{value.note}</small>
                </div>
              );
            })}
          </dl>
          <p className="context-usage-note">
            Counts and lineage cover this whole run; filters apply to retrieval calls.{' '}
            {contextUsageMetric(data, 'read_calls').value} recorded retrieval calls. Assertions
            remain assertions after source checks.
          </p>
          <ContextUsageRows data={data} labels={labels} />
          <nav className="context-usage-pagination" aria-label="Context retrieval pages">
            <button
              type="button"
              className="quiet"
              disabled={loading || pages.length === 1}
              onClick={() => setPages((current) => current.slice(0, -1))}
            >
              Previous
            </button>
            <span>Page {pages.length} · up to 30 calls per page</span>
            <button
              type="button"
              className="quiet"
              disabled={
                loading || !data.has_more || data.next_cursor == null || data.next_cursor <= cursor
              }
              onClick={() => {
                const next = data.next_cursor;
                if (next != null) setPages((current) => [...current, next]);
              }}
            >
              Next
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
