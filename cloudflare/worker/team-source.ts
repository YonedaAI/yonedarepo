import { source } from './artifacts';
import { error, response } from './http';
import { ledger } from './storage';
import type { Env, Json } from './types';

/** Fetch one frozen input at a time; Rust owns assembly and path-scope enforcement. */
export async function teamAttemptSource(env: Env, job: Json, index: unknown) {
  if (!['agent', 'capture'].includes(job.kind) || !job.payload.execution?.team_task)
    throw new Error('This attempt has no team source capability');
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)
    throw new Error('Invalid frozen team input index');
  const input = job.payload.team_inputs?.[index];
  if (!input?.revision || typeof input.tree !== 'string')
    throw new Error('Frozen team input is missing');
  return { input, ...(await source(env, input.revision, input.tree)) };
}

/** Owner inspection resolves immutable task output; query arguments cannot choose a revision. */
export async function teamTaskSource(env: Env, repo: string, run: string, taskId: string) {
  const snapshot = await ledger(env, repo, { op: 'snapshot' });
  const task = snapshot.team_tasks?.find(
    (item: Json) => item.run_id === run && item.task_id === taskId,
  );
  if (!task?.output?.revision || typeof task.output.tree !== 'string')
    return error('NOT_FOUND', 'Task has no recorded captured source', 404);
  const files = await source(env, task.output.revision, task.output.tree);
  const result = response({
    task_id: task.task_id,
    revision: task.output.revision,
    tree: task.output.tree,
    ...files,
  });
  result.headers.set('cache-control', 'no-store');
  return result;
}
