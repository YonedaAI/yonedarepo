import { useEffect, useState } from 'react';
import type { Snapshot } from '../../lib/types';
import { RecordedContent } from '../graph/EvidenceFields';
import { activityLabel, elapsedTime, eventExecution, eventInRun } from './activityView';
import { useActivityEvents } from './useActivityEvents';

export function AgentActivityTimeline({
  snapshot,
  run,
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
}) {
  const { events, error, loading } = useActivityEvents(snapshot.repository.id);
  const [now, setNow] = useState(Date.now());
  const [agent, setAgent] = useState('');
  const [limit, setLimit] = useState(50);
  const executions = snapshot.executions.filter((execution) => execution.run_id === run.id);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const relevant = events.filter((event) => eventInRun(event, snapshot, run.id));
  const filtered = agent
    ? relevant.filter((event) => eventExecution(event, snapshot, run.id)?.id === agent)
    : relevant;
  const shown = filtered.slice(-limit);
  return (
    <section className="agent-timeline" aria-labelledby="agent-timeline-heading">
      <h2 id="agent-timeline-heading">Recorded activity timeline</h2>
      <p className="subtle">
        Elapsed times use ledger timestamps. Events describe progress; captures and checks establish
        results.
      </p>
      <label>
        Activity for
        <select
          value={agent}
          onChange={(event) => {
            setAgent(event.target.value);
            setLimit(50);
          }}
        >
          <option value="">All agents and run events</option>
          {executions.map((execution) => (
            <option key={execution.id} value={execution.id}>
              {execution.strategy || execution.team_role || execution.role} ·{' '}
              {execution.model || execution.id}
            </option>
          ))}
        </select>
      </label>
      <ul className="agent-elapsed" aria-label="Agent elapsed times">
        {executions.map((execution) => {
          const start = execution.started_at ?? execution.created_at;
          return (
            <li key={execution.id}>
              <strong>{execution.strategy || execution.team_role || execution.role}</strong> ·{' '}
              {execution.status.replaceAll('_', ' ')} ·{' '}
              {typeof start === 'number'
                ? `${elapsedTime((execution.finished_at ?? now) - start)} elapsed`
                : 'Start time not recorded'}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert">
          Activity could not refresh: {error}. Previously recorded events remain visible.
        </p>
      )}
      {loading && <p role="status">Loading recorded events…</p>}
      {!loading && !filtered.length && <p>No recorded events for this selection yet.</p>}
      {filtered.length > limit && (
        <button type="button" className="quiet" onClick={() => setLimit(limit + 100)}>
          Show earlier activity ({filtered.length - limit} more)
        </button>
      )}
      <ol className="activity-events">
        {shown.map((event) => {
          const execution = eventExecution(event, snapshot, run.id);
          const progress = event.data.progress;
          return (
            <li key={event.seq}>
              <time dateTime={new Date(event.at).toISOString()}>
                {new Date(event.at).toLocaleTimeString()} · +
                {elapsedTime(event.at - (run.created_at ?? event.at))}
              </time>
              <div>
                <strong>{activityLabel(event)}</strong>
                <p>
                  {execution
                    ? `${execution.strategy || execution.team_role || execution.role} · ${execution.model || execution.harness}`
                    : 'Run event'}
                  {event.data.epoch != null ? ` · attempt ${event.data.epoch}` : ''}
                </p>
                {progress != null && (
                  <RecordedContent
                    content={typeof progress === 'string' ? progress : JSON.stringify(progress)}
                  />
                )}
                {event.data.error && (
                  <RecordedContent
                    content={
                      typeof event.data.error === 'string'
                        ? event.data.error
                        : JSON.stringify(event.data.error)
                    }
                  />
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
