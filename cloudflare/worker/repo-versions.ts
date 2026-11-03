// Transport for the explicitly advertised browser read; Rust owns range/cursor rules.
import { ApiError, type RepoContext } from './repo-ops';
export function recentVersions(ctx: RepoContext, query: Record<string, string>) {
  if (ctx.env.RECENT_VERSIONS !== 'on')
    throw new ApiError('NOT_SUPPORTED', 'Recent version pages are not enabled');
  const command: Record<string, unknown> = {
    op: 'repo_txlog',
    recent: true,
    compact: query.compact === 'true',
    ...(query.history_chain !== undefined && { history_chain: query.history_chain }),
  };
  for (const key of ['limit', 'before', 'through']) {
    if (query[key] === undefined) continue;
    const value = Number(query[key]);
    if (!query[key] || !Number.isSafeInteger(value) || value < 0)
      throw new ApiError('INVALID_INPUT', `${key} must be a nonnegative integer`);
    command[key] = value;
  }
  return ctx.call(command);
}
