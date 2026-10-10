import type { Snapshot } from '../../lib/types';

export interface ActivityEvent {
  seq: number;
  at: number;
  kind: string;
  data: Record<string, any>;
}

/** Resolve job IDs through recorded identities; prefix matching could mix neighboring runs. */
export function eventExecution(event: ActivityEvent, snapshot: Snapshot, runId: string) {
  const data = event.data;
  const id = data.job_id ?? data.reservation?.job_id ?? data.id;
  const executionId = data.execution_id ?? data.execution ?? data.producer ?? data.author;
  return snapshot.executions.find((execution) => {
    if (execution.run_id !== runId) return false;
    if (execution.id === executionId || execution.id === id) return true;
    const candidates = snapshot.candidates.filter(
      (candidate) => candidate.execution === execution.id,
    );
    return (
      id === `job:${execution.id}` ||
      id === `capture:${execution.id}` ||
      (execution.team_task_revision &&
        id === `capture:${execution.id}:r${execution.team_task_revision}`) ||
      candidates.some(
        (candidate) =>
          id === candidate.capture_job ||
          id === `evaluate:${candidate.id}` ||
          data.candidate === candidate.id,
      )
    );
  });
}

export function eventInRun(event: ActivityEvent, snapshot: Snapshot, runId: string) {
  if (eventExecution(event, snapshot, runId)) return true;
  const data = event.data;
  if (data.run_id === runId || data.reservation?.run_id === runId) return true;
  if (event.kind.startsWith('run.') && data.id === runId) return true;
  return snapshot.decisions.some(
    (decision) =>
      decision.run_id === runId &&
      (data.id === `publish:${decision.id}` ||
        data.decision_id === decision.id ||
        (event.kind.startsWith('decision.') && data.id === decision.id)),
  );
}

export function elapsedTime(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function activityLabel(event: ActivityEvent) {
  const job = event.data.kind;
  const stage =
    job === 'capture'
      ? 'Source capture'
      : job === 'evaluate'
        ? 'Independent checks'
        : job === 'publish'
          ? 'Publication'
          : 'Agent work';
  const names: Record<string, string> = {
    'job.started': `${stage} started`,
    'job.completed': `${stage} completed`,
    'job.failed': 'Attempt failed',
    'job.recovered': 'Attempt recovered after interruption',
    'job.progress': 'Progress recorded',
    'context.published': 'Agent context recorded · assertion',
    'artifact.published': 'Agent research artifact recorded · assertion',
    'team.task_captured': 'Task source captured',
    'team.task_scheduled': 'Task scheduled',
    'team.task_retried': 'Task retry approved',
    'run.created': 'Run started',
    'run.cancelled': 'Run cancelled',
    'decision.selected': 'Shipping decision recorded',
    'model.request_reserved': 'Model request reserved',
    'model.request_settled': 'Model request usage recorded',
  };
  return names[event.kind] ?? event.kind.replaceAll('.', ' · ').replaceAll('_', ' ');
}

/** Terminal records without a finish timestamp use their recorded stop event, never wall time. */
export function executionElapsed(
  execution: Record<string, any>,
  events: ActivityEvent[],
  snapshot: Snapshot,
  runId: string,
  now: number,
): number | null {
  const start = execution.started_at ?? execution.created_at;
  if (typeof start !== 'number') return null;
  if (typeof execution.finished_at === 'number') return execution.finished_at - start;
  if (!['failed', 'cancelled', 'completed', 'fenced'].includes(execution.status))
    return now - start;
  const stopped = events.filter(
    (event) =>
      (['job.failed', 'job.completed'].includes(event.kind) &&
        eventExecution(event, snapshot, runId)?.id === execution.id) ||
      (event.kind === 'run.cancelled' && event.data.id === runId),
  );
  return stopped.length ? Math.max(...stopped.map((event) => event.at)) - start : null;
}
