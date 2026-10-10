import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { ExecutionLogs } from '../exploration/ExecutionLogs';
import { TeamHandoff } from './TeamHandoff';
import { TeamSource } from './TeamSource';
import {
  canRetryTeamTask,
  dependencyBlockers,
  type TeamRecord,
  taskError,
  teamAgentBusy,
  teamOwner,
} from './teamView';
export function TeamTaskCard({
  task,
  tasks,
  run,
  reviewer = false,
  snapshot,
  busy,
  onRetry,
  onProviders,
}: {
  reviewer?: boolean;
  task: TeamRecord;
  tasks: TeamRecord[];
  run: TeamRecord;
  snapshot: Snapshot;
  busy: boolean;
  onRetry: (task: TeamRecord) => void;
  onProviders?: () => void;
}) {
  const execution = snapshot.executions.find((item) => item.id === task.execution_id);
  const handoffs = (snapshot.team_handoffs ?? []).filter(
    (item) => item.run_id === run.id && item.task_id === task.task_id,
  );
  const blockers = dependencyBlockers(task, tasks);
  const error = taskError(task, execution);
  const label = (id: string) => tasks.find((item) => item.task_id === id)?.title ?? id;
  return (
    <li
      className={`team-task-card ${task.role === 'integrator' ? 'integrator' : ''}`}
      id={`team-task-${task.task_id}`}
      tabIndex={-1}
    >
      <div className="team-task-summary">
        <div>
          <h3>{task.title}</h3>
          <small>
            {task.role === 'integrator' ? 'Final integrator' : 'Specialist'} ·{' '}
            {teamOwner(run, task, execution)} · attempt {task.epoch ?? '—'}
          </small>
        </div>
        <span className={`status ${task.status}`}>
          {(task.status ?? 'unknown').replaceAll('_', ' ')}
        </span>
      </div>
      {task.depends_on?.length > 0 && (
        <p>
          Depends on:{' '}
          {task.depends_on.map((id: string, index: number) => (
            <span key={id}>
              {index ? ', ' : ''}
              <a href={`#team-task-${id}`}>{label(id)}</a>
            </span>
          ))}
        </p>
      )}
      {task.status === 'blocked' && (
        <p role="status">
          {blockers.length
            ? `Waiting for ${blockers.map(label).join(', ')}.`
            : teamAgentBusy(task, tasks)
              ? 'Waiting for this agent’s current task and source capture.'
              : 'Waiting for the scheduler to make this task ready.'}
        </p>
      )}
      {task.status === 'queued' && (
        <p role="status">Ready inputs are frozen. Waiting for execution capacity.</p>
      )}
      {task.status === 'failed' && (
        <p className="team-task-error" role="alert">
          {error ||
            'The attempt failed before a usable output was captured. Open its logs for details.'}{' '}
          Dependent work remains blocked.
        </p>
      )}
      {task.status === 'cancelled' && (
        <p>This task is cancelled. Its recorded evidence remains available.</p>
      )}
      {task.output && (
        <p>
          Captured <code>{short(task.output.revision?.commit)}</code> ·{' '}
          {task.output.paths?.length ?? 0} changed paths
        </p>
      )}
      <details>
        <summary>Task scope and handoffs</summary>
        <p>{task.instructions}</p>
        <p>Writable paths:</p>
        <pre>{(task.write_paths ?? []).join('\n')}</pre>
        {task.output && (
          <>
            <p>Captured changed paths:</p>
            <pre>{(task.output.paths ?? []).join('\n') || 'No changed paths'}</pre>
          </>
        )}
        {handoffs.length ? (
          handoffs.map((handoff) => <TeamHandoff key={handoff.id} handoff={handoff} />)
        ) : (
          <p>
            {task.status === 'complete'
              ? 'No agent-authored handoff was recorded. The source capture remains available.'
              : 'No handoff recorded yet.'}
          </p>
        )}
      </details>
      {execution && (
        <ExecutionLogs
          repo={snapshot.repository.id}
          execution={execution}
          onProviders={reviewer ? undefined : onProviders}
        />
      )}
      {task.status === 'complete' && task.output && (
        <TeamSource repo={snapshot.repository.id} run={run.id} task={task} />
      )}
      {!reviewer &&
        task.status === 'failed' &&
        (canRetryTeamTask(task, tasks, run) ? (
          <button
            type="button"
            className="quiet"
            disabled={busy || snapshot.capabilities?.collaborative_runs !== 1}
            onClick={() => onRetry(task)}
          >
            Retry task
          </button>
        ) : (
          <p>
            {task.revision >= 3
              ? 'This task exhausted its three approved attempts. Start a fresh run to continue.'
              : teamAgentBusy(task, tasks)
                ? 'Retry is available after this agent’s current task and source capture finish.'
                : 'A retry requires a fresh run because dependent work already started or this attempt version is unavailable.'}
          </p>
        ))}
    </li>
  );
}
