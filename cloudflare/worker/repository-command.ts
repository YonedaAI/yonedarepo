import { readJson } from './http';
import type { Json } from './types';

const reads = new Set([
  'snapshot',
  'repository_overview',
  'runs_page',
  'run_detail',
  'run_graph_page',
  'events',
  'graph',
  'why',
  'decision',
  'context_search',
  'context_get',
  'context_usage',
  'execution_logs',
  'conflict_status',
]);
const writes = new Set([
  'init',
  'start_run',
  'accept',
  'cancel_run',
  'observe',
  'update_policy',
  'context_publish',
  'configure_context_study',
  'retry_team_task',
  'repair_team',
  'refresh_candidate',
  'resolve_conflict',
]);

/** Trusted capture, archive commits and remote observations are never generic owner operations. */
export function repositoryOperationAllowed(method: string, action: string): boolean {
  return method === 'GET' ? reads.has(action) : method === 'POST' && writes.has(action);
}

export async function ownerCommandInput(req: Request, action: string): Promise<Json> {
  const input: Json =
    req.method === 'GET'
      ? Object.fromEntries(new URL(req.url).searchParams)
      : await readJson(req, 256 * 1024);
  for (const key of [
    'after',
    'depth',
    'limit',
    'watermark',
    ...(action === 'context_usage' ? ['cursor', 'epoch'] : []),
  ])
    if (input[key] !== undefined) {
      const value = Number(input[key]);
      if (!Number.isSafeInteger(value))
        throw Object.assign(new Error(`Invalid integer ${key}`), { code: 'INVALID_INPUT' });
      input[key] = value;
    }
  // Browser JSON and query parameters cannot acquire attempt or adapter authority.
  for (const key of [
    'job_id',
    ...(action === 'context_usage' ? [] : ['epoch']),
    '_workspace',
    '_grant',
    'session_id',
    'actor',
    'author',
    'workspace',
    '_trusted',
    '_capture',
    '_adapter',
  ])
    delete input[key];
  return input;
}
