import { source } from './artifacts';
import { error, response } from './http';
import { ledger } from './storage';
import type { Env, Json } from './types';

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
