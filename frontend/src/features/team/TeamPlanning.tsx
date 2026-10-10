import type { Snapshot } from '../../lib/types';
import { ExecutionLogs } from '../exploration/ExecutionLogs';
import { type TeamRecord, taskError } from './teamView';
export function TeamPlanning({
  snapshot,
  run,
  onProviders,
}: {
  snapshot: Snapshot;
  run: TeamRecord;
  onProviders?: () => void;
}) {
  if (run.team_planning !== 'automatic') return null;
  const planner = snapshot.executions.find(
    (execution) => execution.run_id === run.id && execution.team_role === 'planner',
  );
  const status = run.team_plan
    ? 'plan validated'
    : (planner?.status ?? (run.status === 'planning' ? 'preparing' : run.status));
  return (
    <div className="team-planning-progress">
      <div className="team-task-summary">
        <strong>Planning from your brief</strong>
        <span className={`status ${planner?.status ?? run.status}`}>
          {status?.replaceAll('_', ' ')}
        </span>
      </div>
      <p>
        {run.team_plan
          ? 'The agent’s task plan passed platform validation. Its assignments and dependencies appear below.'
          : run.status === 'cancelled'
            ? 'Planning was cancelled. No further tasks will start.'
            : planner?.status === 'failed'
              ? 'The planning attempt stopped before producing a valid task plan. Review its logs or restart this run.'
              : 'The planning agent is reading the brief and source, then proposing tasks, interfaces and source ownership for this roster.'}
      </p>
      {planner?.model && <p>Planner · {planner.model}</p>}
      {planner?.status === 'failed' && taskError({}, planner) && (
        <p role="alert" className="team-task-error">
          {taskError({}, planner)}
        </p>
      )}
      {planner && (
        <ExecutionLogs
          repo={snapshot.repository.id}
          execution={planner}
          onProviders={onProviders}
        />
      )}
    </div>
  );
}
