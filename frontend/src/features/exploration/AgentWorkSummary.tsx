import type { Snapshot } from '../../lib/types';
import { executionFailureCode } from './providerFailure';

const active = ['queued', 'running', 'capturing', 'evaluating'];
export function AgentWorkSummary({
  snapshot,
  run,
  onInspect,
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
  onInspect: () => void;
}) {
  const executions = snapshot.executions.filter(
    (item) => item.run_id === run.id && item.role === 'coding',
  );
  const settled = ['ready', 'complete', 'completed', 'published'].includes(run.status);
  const rows = executions.map((execution) => {
    const name = execution.strategy ?? execution.model ?? execution.id;
    // A failed attempt is history, not a blocker, once later work replaced it or the run settled.
    if (execution.status === 'failed' && (settled || laterAttempt(execution, executions))) {
      const timedOut = /TIMEOUT/.test(executionFailureCode(execution) ?? String(execution.error));
      return {
        id: execution.id,
        name,
        status: 'superseded',
        detail: timedOut
          ? 'This attempt timed out; later work completed.'
          : 'A later attempt replaced this one.',
      };
    }
    return {
      id: execution.id,
      name,
      status: execution.status,
      detail: /BUDGET|SPEND_LIMIT|REQUEST_LIMIT/.test(executionFailureCode(execution) ?? '')
        ? 'The approved request limit or workspace allowance is exhausted. No extra inference is scheduled.'
        : errorText(execution.error),
    };
  });
  if (!rows.length) return null;
  return (
    <section className="agent-work-summary" aria-label="Agent work">
      <div className="agent-work-heading">
        <h3>Agent work</h3>
        <button type="button" className="text-button" onClick={onInspect}>
          Inspect agent activity
        </button>
      </div>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <strong>{row.name}</strong>
            <span className={`status ${row.status}`}>
              {active.includes(row.status)
                ? 'Working'
                : ['failed', 'blocked'].includes(row.status)
                  ? 'Blocked'
                  : row.status === 'superseded'
                    ? 'Superseded'
                    : row.status === 'completed'
                      ? 'complete'
                      : row.status?.replaceAll('_', ' ')}
            </span>
            {row.detail && <p>{row.detail}</p>}
            {active.includes(row.status) && <small>Recorded stage: {row.status}</small>}
          </li>
        ))}
      </ul>
      <p className="subtle">Agent progress is separate from independent checks and publication.</p>
    </section>
  );
}

function laterAttempt(execution: Record<string, any>, executions: Record<string, any>[]) {
  const started = execution.started_at ?? execution.created_at ?? 0;
  return executions.some(
    (other) =>
      other.id !== execution.id &&
      other.team_role === execution.team_role &&
      (other.started_at ?? other.created_at ?? 0) > started,
  );
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  const record = error as { message?: string; code?: string } | undefined;
  return record?.message ?? record?.code ?? '';
}
