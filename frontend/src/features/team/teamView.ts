import type { Snapshot } from '../../lib/types';
export type TeamRecord = Record<string, any>;
export function teamTasks(snapshot: Snapshot, run: TeamRecord) {
  const tasks = (snapshot.team_tasks ?? []).filter((task) => task.run_id === run.id);
  // Keep specialists in the approved plan order, followed by final integration.
  const order = new Map<string, number>(
    (run.team_plan?.tasks ?? []).map((task: TeamRecord, index: number) => [task.id, index]),
  );
  return [...tasks].sort(
    (a, b) =>
      (a.role === 'integrator' ? 99 : (order.get(a.task_id) ?? 98)) -
      (b.role === 'integrator' ? 99 : (order.get(b.task_id) ?? 98)),
  );
}
export function dependencyBlockers(task: TeamRecord, tasks: TeamRecord[]) {
  return (task.depends_on ?? []).filter(
    (id: string) => tasks.find((other) => other.task_id === id)?.status !== 'complete',
  );
}
export function teamAgentBusy(task: TeamRecord, tasks: TeamRecord[]) {
  return (
    Number.isSafeInteger(task.agent) &&
    tasks.some(
      (other) =>
        other.task_id !== task.task_id &&
        other.agent === task.agent &&
        ['queued', 'running', 'capturing', 'evaluating'].includes(other.status),
    )
  );
}
export function canRetryTeamTask(task: TeamRecord, tasks: TeamRecord[], run: TeamRecord) {
  if (
    task.status !== 'failed' ||
    ['accepted', 'cancelled'].includes(run.status) ||
    !Number.isSafeInteger(task.epoch) ||
    !Number.isSafeInteger(task.revision) ||
    task.revision >= 3 ||
    teamAgentBusy(task, tasks)
  )
    return false;
  const descendants = new Set([task.task_id]);
  for (let pass = 0; pass < tasks.length; pass++)
    for (const other of tasks)
      if (other.depends_on?.some((id: string) => descendants.has(id)))
        descendants.add(other.task_id);
  return !tasks.some(
    (other) =>
      other.task_id !== task.task_id &&
      descendants.has(other.task_id) &&
      (other.status !== 'blocked' || (other.epoch ?? 0) !== 0),
  );
}
export function taskError(task: TeamRecord, execution?: TeamRecord) {
  const error = task.error ?? execution?.error;
  if (typeof error === 'string') return error;
  return error?.message ?? error?.code ?? '';
}
export function teamOwner(run: TeamRecord, task: TeamRecord, execution?: TeamRecord) {
  const agent = run.agents?.[task.agent];
  return `Agent ${Number.isSafeInteger(task.agent) ? task.agent + 1 : '—'}${(execution?.model ?? agent?.model) ? ` · ${execution?.model ?? agent.model}` : ''}`;
}
export function integratedExecutions(snapshot: Snapshot, run: TeamRecord) {
  return snapshot.executions.filter(
    (execution) =>
      execution.run_id === run.id &&
      execution.role === 'coding' &&
      execution.team_role === 'integrator',
  );
}
/** Retries reuse the integrator execution; its task row names the current captured candidate. */
export function runCandidates(snapshot: Snapshot, run?: TeamRecord) {
  const candidates = snapshot.candidates.filter((candidate) => candidate.run_id === run?.id);
  if (run?.mode !== 'collaborate') return candidates;
  const task = (snapshot.team_tasks ?? []).find(
    (item) => item.run_id === run.id && item.role === 'integrator',
  );
  return candidates.filter(
    (candidate) =>
      candidate.id === task?.candidate_id && candidate.execution === task?.execution_id,
  );
}
