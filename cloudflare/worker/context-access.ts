import { sanitizeContextResponse } from './context-policy';
import { ledger, sha } from './storage';
import type { Env, Json } from './types';

const tracked = new Set([
  'repo_context',
  'context_search',
  'context_get',
  'graph',
  'why',
  'decision',
  'artifact_get',
  'team_context',
  'integration_request',
]);

/** Record only records actually present in the sanitized successful response. */
export async function contextResponse(
  env: Env,
  repo: string,
  identity: Json,
  tool: string,
  value: Json,
) {
  const result = await sanitizeContextResponse(env, repo, identity, tool, value);
  if (!tracked.has(tool)) return result;
  const targets = new Map<string, { id: string; digest?: string }>();
  const add = (record: unknown) => {
    if (!record || typeof record !== 'object') return;
    const entry = record as Json;
    if (typeof entry.id !== 'string') return;
    const digest = entry.digest ?? entry.evidence;
    targets.set(entry.id, {
      id: entry.id,
      ...(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) ? { digest } : {}),
    });
  };
  if (['context_get', 'decision', 'artifact_get'].includes(tool)) add(result);
  for (const key of [
    'items',
    'nodes',
    'context',
    'context_records',
    'plain_notes',
    'decisions',
    'runs',
    'handoffs',
  ])
    if (Array.isArray(result[key])) for (const record of result[key]) add(record);
  if (tool === 'repo_context') {
    add(result.repository);
    add(result.run);
    add(result.execution);
    if (typeof result.intent_id === 'string') add({ id: result.intent_id });
    const runs = [result.run, ...(Array.isArray(result.runs) ? result.runs : [])];
    for (const run of runs)
      if (Array.isArray(run?.context_records))
        for (const record of run.context_records) add(record);
  }
  if (tool === 'team_context' || tool === 'integration_request') {
    add(result.run);
    add(result.execution);
    add(result.manifest_record);
  }
  await ledger(env, repo, {
    ...identity,
    op: 'record_context_access',
    call_id: crypto.randomUUID(),
    tool,
    stage: tool === 'context_search' ? 'returned' : 'opened',
    targets: [...targets.values()],
    response_digest: await sha(JSON.stringify(result)),
  });
  return result;
}
