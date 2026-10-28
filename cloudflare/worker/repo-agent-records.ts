// Read-only, repository-wide views of what agents record, for the web's agent pages:
// session records (GET sessions, sessions/<id>), authored contract records (GET contracts),
// pins (GET pins) and bisects (GET bisect). The authority decides access; this only maps
// query strings onto its operations.
import { ApiError, type Json, type RepoContext } from './repo-ops';

/** A positive integer query parameter, absent when not given. */
function count(query: Record<string, string>, key: string): number | undefined {
  const text = query[key];
  if (text === undefined || text === '') return undefined;
  if (!/^[1-9][0-9]{0,15}$/.test(text))
    throw new ApiError('INVALID_INPUT', `${key} must be a positive integer`);
  return Number(text);
}

const RESOURCES = new Set(['sessions', 'contracts', 'pins', 'bisect']);

/** The answer to a GET of `resource[/id]`, or undefined when it is not an agent record. */
export function agentRecords(
  ctx: RepoContext,
  resource: string | undefined,
  id: string | undefined,
  sub: string | undefined,
  query: Record<string, string>,
): Promise<Json> | undefined {
  if (!resource || !RESOURCES.has(resource) || sub !== undefined) return undefined;
  if (id !== undefined)
    return resource === 'sessions'
      ? ctx.call({ op: 'repo_session_show', id: count({ id }, 'id') })
      : undefined;
  const page = { before: count(query, 'before'), limit: count(query, 'limit') };
  if (resource === 'sessions')
    return ctx.call({
      op: 'repo_session_list',
      cli: query.cli || null,
      model: query.model || null,
      ref: query.ref || null,
      head: query.head || null,
      base: query.base || null,
      ...page,
    });
  if (resource === 'contracts') return ctx.call({ op: 'repo_contract_list', ...page });
  if (resource === 'pins') return ctx.call({ op: 'repo_pin_list' });
  return ctx.call({ op: 'repo_bisect_list', limit: page.limit });
}
