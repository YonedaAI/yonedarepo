import { readJson } from './http';
import type { Json } from './types';

const reads = new Set([
  'snapshot',
  'working_branch',
  'working_branches',
  'repository_overview',
  'runs_page',
  'run_detail',
  'run_graph_page',
  'events',
  'peer_messages_page',
  'graph',
  'why',
  'decision',
  'context_search',
  'context_get',
  'context_usage',
  'execution_logs',
  'conflict_status',
  'job_status',
  'candidate_paths',
  'conflict_paths',
]);
const writes = new Set([
  'init',
  'start_run',
  'create_working_branch',
  'answer_intent',
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
  'run_set_visibility',
  'approve_comparison_review',
  'select_comparison_candidate',
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
    ...(['candidate_paths', 'conflict_paths'].includes(action) ? [] : ['after']),
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
    'campaign',
    '_campaign_grant',
    '_campaign_signing_key',
    'repair_escalation',
    '_approved_model_pool',
    'approved_model_pool',
    'planned_roster_digest',
    '_workspace_spend',
    'workspace_spend',
    '_sample_profile',
    'sample_profile',
    'comparison_approval',
    'comparison_approval_id',
    'comparison_role',
    'review_only',
    'comparison_review',
    'comparison_manifest',
    'workspace_transport',
    'source_workspace',
    'source_mounts',
    'source_changeset',
    'source_view',
    'source_approval',
  ])
    delete input[key];
  for (const key of Object.keys(input))
    if (key.startsWith('_comparison_') || key.startsWith('_source_')) delete input[key];
  return input;
}
