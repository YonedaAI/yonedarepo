import { useState } from 'react';
import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { ExecutionLogs } from '../exploration/ExecutionLogs';
import { capturedPathCount } from '../source-workspace/sourcePathCount';
import { TeamHandoff } from './TeamHandoff';
import { TeamRetry } from './TeamRetry';
import { TeamSource } from './TeamSource';
import {
  classifyTeamHandoffs,
  dependencyBlockers,
  interruptedTask,
  retryBlocker,
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
  const taskHandoffs = (snapshot.team_handoffs ?? []).filter(
    (item) => item.run_id === run.id && item.task_id === task.task_id,
  );
  const { assertions, captures, superseded } = classifyTeamHandoffs(taskHandoffs);
  const blockers = dependencyBlockers(task, tasks);
  const error = taskError(task, execution);
  const outputPathCount = capturedPathCount(task.output);
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
          {blockers.some(
            (id: string) => tasks.find((other) => other.task_id === id)?.status === 'failed',
          )
            ? `Blocked until ${blockers.map(label).join(', ')} succeeds. Use Retry task on it; this task starts automatically afterwards.`
            : blockers.length
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
          {outputPathCount == null
            ? 'Changed-path count unavailable'
            : `${outputPathCount} changed paths`}
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
            className="team-task-repair-form"
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
                rows={4}
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
            <pre>
              {Array.isArray(task.output.paths)
                ? task.output.paths.join('\n') || 'No changed paths'
                : outputPathCount == null
                  ? 'Changed-path list unavailable.'
                  : 'Changed paths are stored in a paged list.'}
            </pre>
          </>
        )}
        {assertions.map((handoff) => (
          <TeamHandoff key={handoff.id} handoff={handoff} />
        ))}
        {captures.map((handoff) => (
          <TeamHandoff key={handoff.id} handoff={handoff} />
        ))}
        {superseded.map((handoff) => (
          <TeamHandoff key={handoff.id} handoff={handoff} />
        ))}
        {!assertions.length && !captures.length && !superseded.length && (
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
      {!reviewer && task.status === 'failed' && (
        <TeamRetry
          blocker={retryBlocker(task, tasks, run, execution)}
          resumes={interruptedTask(task, execution)}
          disabled={busy || snapshot.capabilities?.collaborative_runs !== 1}
          onRetry={() => onRetry(task)}
        />
      )}
    </li>
  );
}
