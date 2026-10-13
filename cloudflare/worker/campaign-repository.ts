import { candidateSource, publishedSource } from './candidate-source';
import { error, response, safeId } from './http';
import { ownerCommandInput } from './repository-command';
import { ledger } from './storage';
import { approveTestPolicy } from './test-policy';
import type { Env, Json } from './types';

const reads = new Set([
  'repository_status',
  'snapshot',
  'repository_overview',
  'working_branch',
  'working_branches',
  'run_detail',
  'runs_page',
  'context_get',
  'context_search',
  'context_usage',
  'events',
  'job_status',
  'candidate_source',
  'published_source',
  'peer_messages_page',
]);
const writes = new Set(['create_working_branch', 'approve_test_bundle', 'cancel_run']);

/** Operator-only preparation/read-through. Paid run approval uses the signed route. */
export async function campaignRepository(env: Env, owner: string, command: Json) {
  if (!safeId(command.repo_id) || typeof command.action !== 'string')
    return error('INVALID_INPUT', 'An explicit campaign repository and action are required');
  if (!reads.has(command.action) && !writes.has(command.action))
    return error('NOT_FOUND', 'Unsupported operator repository action', 404);
  const repo = command.repo_id;
  await ledger(env, repo, { op: 'repository_status', _workspace: owner });
  const input = command.input ?? {};
  if (typeof input !== 'object' || Array.isArray(input) || input === null)
    return error('INVALID_INPUT', 'Operator action input must be an object');
  if (command.action === 'published_source') return publishedSource(env, repo);
  if (command.action === 'candidate_source') return candidateSource(env, repo, input.id ?? '');
  const request = new Request('https://operator.invalid/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (command.action === 'approve_test_bundle')
    return approveTestPolicy(request, env, { role: 'admin', workspace: owner }, repo);
  const scoped = await ownerCommandInput(request, command.action);
  return response(await ledger(env, repo, { ...scoped, op: command.action, _workspace: owner }));
}
