import { useState } from 'react';
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
  onRepair,
  onProviders,
}: {
  reviewer?: boolean;
  task: TeamRecord;
  tasks: TeamRecord[];
  run: TeamRecord;
  snapshot: Snapshot;
  busy: boolean;
  onRetry: (task: TeamRecord) => void;
  onRepair: (request: Record<string, unknown>) => Promise<boolean>;
  onProviders?: () => void;
}) {
  const execution = snapshot.executions.find((item) => item.id === task.execution_id);
  const handoffs = (snapshot.team_handoffs ?? []).filter(
    (item) => item.run_id === run.id && item.task_id === task.task_id,
  );
  const blockers = dependencyBlockers(task, tasks);
  const error = taskError(task, execution);
  const [repairBrief, setRepairBrief] = useState('');
  const [repairRequest, setRepairRequest] = useState<Record<string, unknown> | null>(null);
  const [repairSending, setRepairSending] = useState(false);
  const [repairStatus, setRepairStatus] = useState('');
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
      {execution?.progress && task.status === 'running' && (
        <p role="status" aria-live="polite">
          {typeof execution.progress === 'string'
            ? execution.progress
            : execution.progress.stage?.replaceAll('_', ' ') || 'Task progress recorded'}
        </p>
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
      {(task.status === 'failed' ||
        (task.output && task.output.revision?.commit !== snapshot.repository.head_commit)) && (
        <details className="team-task-repair">
          <summary>
            {reviewer
              ? 'Repair task using existing trial approval'
              : 'Repair task from current revision'}
          </summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (repairSending) return;
              if (!repairRequest && repairBrief.trim().length < 8) {
                setRepairStatus('Add a repair brief with at least 8 characters.');
                return;
              }
              if (
                !repairRequest &&
                (!Number.isSafeInteger(run.team_plan_revision) ||
                  !Number.isSafeInteger(task.revision))
              ) {
                setRepairStatus(
                  'The frozen plan or task revision is unavailable. Refresh this run before repairing.',
                );
                return;
              }
              const request = repairRequest ?? {
                run_id: run.id,
                expected_plan_revision: run.team_plan_revision,
                task_ids: [task.task_id],
                expected_task_revisions: { [task.task_id]: task.revision },
                owner_brief: repairBrief.trim(),
                expected_commit: snapshot.repository.head_commit,
                expected_version: snapshot.repository.version,
                request_id: crypto.randomUUID(),
              };
              setRepairRequest(request);
              setRepairSending(true);
              setRepairStatus('');
              void onRepair(request)
                .then((accepted) => {
                  if (accepted) {
                    setRepairRequest(null);
                    setRepairBrief('');
                    setRepairStatus(
                      'Repair request accepted. The selected task and its dependents will be refreshed.',
                    );
                  } else {
                    setRepairStatus(
                      'Repair was not acknowledged. Retry sends the same request ID and expected revisions.',
                    );
                  }
                })
                .catch(() => {
                  setRepairStatus(
                    'Repair was not acknowledged. Retry sends the same request ID and expected revisions.',
                  );
                })
                .finally(() => setRepairSending(false));
            }}
          >
            <label>
              Repair brief
              <textarea
                value={repairBrief}
                onChange={(event) => setRepairBrief(event.target.value)}
                required
                minLength={8}
                maxLength={4000}
                placeholder="Describe the focused repair. Dependent tasks will be refreshed by the backend."
                disabled={busy || repairSending}
              />
            </label>
            <button
              type="submit"
              className="quiet"
              disabled={busy || repairSending || !repairBrief.trim()}
            >
              {repairSending
                ? 'Requesting repair…'
                : repairRequest
                  ? 'Retry same repair request'
                  : 'Start scoped repair'}
            </button>
            {repairRequest && !repairSending && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setRepairRequest(null);
                  setRepairStatus('');
                }}
              >
                Revise brief as a new request
              </button>
            )}
            {repairStatus && <p role="status">{repairStatus}</p>}
          </form>
        </details>
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
