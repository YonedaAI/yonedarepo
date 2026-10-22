import type { Snapshot } from '../../lib/types';
export type TeamRecord = Record<string, any>;
export function classifyTeamHandoffs(handoffs: TeamRecord[]) {
  return {
    assertions: handoffs.filter((item) => item.authority === 'assertion'),
    captures: handoffs.filter((item) => item.authority === 'captured_revision'),
    superseded: handoffs.filter((item) => item.authority === 'superseded'),
  };
}
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
const RESUMABLE = ['EXECUTION_TIMEOUT', 'HARNESS_INTERRUPTED', 'LEASE_EXPIRED'];
/** Interruptions (timeouts, stopped harnesses) resume from staged files and keep no retry cap. */
export function interruptedTask(task: TeamRecord, execution?: TeamRecord) {
  const error = taskError(task, execution);
  return RESUMABLE.some(
    (code) =>
      error === code || error.startsWith(`${code}:`) || error === 'Execution deadline exceeded',
  );
}
function microusd(value: number) {
  return `$${(value / 1_000_000).toFixed(2)}`;
}
/** A real approved allowance that would refuse the retry's model requests, with numbers. */
export function spendBlocker(run: TeamRecord, execution?: TeamRecord) {
  const budget = (run.model_budgets ?? []).find(
    (item: TeamRecord) => item.provider === execution?.provider && item.model === execution?.model,
  );
  if (!budget) return undefined;
  if (Number.isSafeInteger(budget.max_requests) && budget.requests >= budget.max_requests)
    return `Retry is blocked by the approved request allowance for ${budget.model}: ${budget.requests} of ${budget.max_requests} requests are used.`;
  if (
    Number.isSafeInteger(budget.spend_limit_microusd) &&
    budget.charged_microusd >= budget.spend_limit_microusd
  )
    return `Retry is blocked by the approved spend allowance for ${budget.model}: ${microusd(budget.charged_microusd)} of ${microusd(budget.spend_limit_microusd)} is used.`;
  return undefined;
}
/** Why the owner cannot retry this failed task right now, or undefined when Retry works. */
export function retryBlocker(
  task: TeamRecord,
  tasks: TeamRecord[],
  run: TeamRecord,
  execution?: TeamRecord,
) {
  if (task.status !== 'failed' || ['accepted', 'cancelled'].includes(run.status))
    return 'This run is closed.';
  if (!Number.isSafeInteger(task.epoch) || !Number.isSafeInteger(task.revision))
    return 'This task record is still loading. Refresh to retry.';
  if (task.revision >= 3 && !interruptedTask(task, execution))
    return 'This task failed on its three approved attempts. Start a fresh run to continue.';
  if (teamAgentBusy(task, tasks))
    return 'Retry is available after this agent’s current task and source capture finish.';
  const descendants = new Set([task.task_id]);
  for (let pass = 0; pass < tasks.length; pass++)
    for (const other of tasks)
      if (other.depends_on?.some((id: string) => descendants.has(id)))
        descendants.add(other.task_id);
  if (
    tasks.some(
      (other) =>
        other.task_id !== task.task_id &&
        descendants.has(other.task_id) &&
        (other.status !== 'blocked' || (other.epoch ?? 0) !== 0),
    )
  )
    return 'Dependent work already started from this task, so a retry needs a fresh run.';
  return spendBlocker(run, execution);
}
export function canRetryTeamTask(
  task: TeamRecord,
  tasks: TeamRecord[],
  run: TeamRecord,
  execution?: TeamRecord,
) {
  return retryBlocker(task, tasks, run, execution) === undefined;
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
  // A recorded conflict resolution supersedes the integrated result it reconciled.
  const resolved = candidates.filter((candidate) => candidate.conflict_id).reverse();
  const integrated = candidates.filter(
    (candidate) =>
      candidate.id === task?.candidate_id && candidate.execution === task?.execution_id,
  );
  // Show one result per run: once reconciled, the earlier integration stays in history only.
  return resolved.length ? resolved.slice(0, 1) : integrated;
}
