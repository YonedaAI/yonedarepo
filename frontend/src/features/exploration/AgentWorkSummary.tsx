import type { Snapshot } from '../../lib/types';
import { dependencyBlockers, taskError, teamTasks } from '../team/teamView';
import { AutonomySummary } from './AutonomySummary';
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
    (item) =>
      item.run_id === run.id && (item.role === 'coding' || item.comparison_role === 'reviewer'),
  );
  const tasks = teamTasks(snapshot, run);
  const rows = tasks.map((task) => {
    const execution = executions.find((item) => item.id === task.execution_id);
    const waiting = dependencyBlockers(task, tasks).map(
      (id: string) => tasks.find((item) => item.task_id === id)?.title ?? id,
    );
    return {
      id: `task:${task.task_id}`,
      name: task.title ?? task.task_id,
      status: task.status,
      repairing: (run.team_repair_rounds ?? 0) > 0 && task.revision > 1,
      detail:
        taskError(task, execution) || (waiting.length ? `Waiting for ${waiting.join(', ')}` : ''),
    };
  });
  const settled = ['ready', 'complete', 'completed', 'published'].includes(run.status);
  for (const execution of executions.filter(
    (item) => !tasks.some((task) => task.execution_id === item.id),
  )) {
    // A failed attempt is history, not a blocker, once later work replaced it or the run settled.
    if (execution.status === 'failed' && (settled || laterAttempt(execution, executions))) {
      const timedOut = /TIMEOUT/.test(executionFailureCode(execution) ?? String(execution.error));
      rows.push({
        id: execution.id,
        name: execution.strategy ?? execution.model ?? execution.id,
        status: 'superseded',
        repairing: false,
        detail: timedOut
          ? 'This attempt timed out; later work completed.'
          : 'A later attempt replaced this one.',
      });
      continue;
    }
    rows.push({
      id: execution.id,
      name:
        execution.comparison_role === 'reviewer'
          ? 'Automatic reviewer'
          : (execution.strategy ?? execution.model ?? execution.id),
      status: execution.status,
      repairing: execution.comparison_role === 'repair' || itemRepair(execution, run),
      detail: /BUDGET|SPEND_LIMIT|REQUEST_LIMIT/.test(executionFailureCode(execution) ?? '')
        ? 'The approved request limit or workspace allowance is exhausted. No extra inference is scheduled.'
        : taskError({}, execution),
    });
  }
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
                ? row.repairing
                  ? 'Repairing'
                  : 'Working'
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
      <AutonomySummary run={run} />
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

function itemRepair(execution: Record<string, any>, run: Record<string, any>) {
  return execution.team_role === 'coordinator' && (run.team_repair_rounds ?? 0) > 0;
}
