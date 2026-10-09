/** Controls are confined to explicitly configured, disposable operator study repositories. */
import { ledger } from './storage';
import type { Env, Json } from './types';

type Study = {
  id: string;
  case: string;
  arm: 'source_only' | 'plain_notes' | 'graph';
  records: Json[];
};

async function configuration(env: Env, repo: string, identity: Json): Promise<Study | undefined> {
  if (identity.job_id) {
    const context = await ledger(env, repo, { ...identity, op: 'context' });
    return context.run?.context_study;
  }
  const repository = await ledger(env, repo, {
    op: 'repository_status',
    ...(identity._workspace ? { _workspace: identity._workspace } : {}),
  });
  return repository.context_study;
}

export async function guardContextAccess(
  env: Env,
  repo: string,
  identity: Json,
  tool: string,
  _args: Json,
): Promise<void> {
  const study = await configuration(env, repo, identity);
  if (!study || study.arm === 'graph') return;
  if (['context_search', 'context_get', 'graph', 'why', 'decision', 'artifact_get'].includes(tool))
    throw new Error('CONTEXT_STUDY_RESTRICTED: historical retrieval is unavailable in this trial');
}

/** Hide history in every response surface, including status tools, not merely tools/list. */
export async function sanitizeContextResponse(
  env: Env,
  repo: string,
  identity: Json,
  tool: string,
  value: Json,
): Promise<Json> {
  const study = await configuration(env, repo, identity);
  if (!study) return value;
  if (tool === 'context_usage' && study.arm !== 'graph')
    return {
      ...value,
      coverage: {
        ...value.coverage,
        status: 'restricted_by_study',
        reason: 'Historical access is disabled in this study condition',
      },
      entries: [],
      assigned: [],
      citations: [],
      checked: [],
      counts: { assigned: 0, returned: 0, opened: 0, cited: 0, checked: 0, read_calls: 0 },
      has_more: false,
      next_cursor: 0,
    };
  // Initial reads must not preload the graph arm's historical information either.
  if (
    [
      'repo_context',
      'execution_status',
      'attempt_begin',
      'attempt_status',
      'delegation_status',
    ].includes(tool)
  ) {
    const result = scrub(value);
    if (study.arm === 'plain_notes') result.plain_notes = study.records;
    return result;
  }
  if (study.arm !== 'graph') return scrub(value);
  return stripControl(value);
}

function stripControl(value: Json): Json {
  const result: Json = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'context_study') continue;
    result[key] = Array.isArray(item)
      ? item.map((v) => (v && typeof v === 'object' ? stripControl(v) : v))
      : item && typeof item === 'object'
        ? stripControl(item)
        : item;
  }
  return result;
}

function scrub(value: Json): Json {
  const result: Json = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'context_study') continue;
    if (['context', 'context_records', 'decisions', 'runs', 'artifacts'].includes(key)) {
      result[key] = [];
    } else if (Array.isArray(item)) {
      result[key] = item.map((value) =>
        value && typeof value === 'object' ? scrub(value) : value,
      );
    } else if (item && typeof item === 'object') {
      result[key] = scrub(item);
    } else result[key] = item;
  }
  return result;
}
