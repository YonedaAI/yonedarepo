// Repository members: other accounts that use a repository with a role (read, write, land
// or admin). The authority decides who may manage whom; this adapter checks that an
// invited account exists (its WorkspaceAuthority), keeps the D1 membership index that
// lists shared repositories, and marks the published head stale so a change of access
// reaches stateless reads at once.
import { ACCOUNT_IDENTIFIER_HELP, normalizeAccountIdentifier } from '../../shared/account';
import { refreshHead } from './repo-head';
import { ApiError, type Json, type RepoContext } from './repo-ops';
import { workspace } from './workspace';

function accountArg(value: unknown) {
  const account = typeof value === 'string' ? normalizeAccountIdentifier(value) : null;
  if (!account) throw new ApiError('INVALID_INPUT', ACCOUNT_IDENTIFIER_HELP);
  return account;
}

export const memberOperations = {
  git_member_list: (ctx: RepoContext) => ctx.call({ op: 'repo_members' }),
  git_member_add: async (ctx: RepoContext, a: Json) => {
    const account = accountArg(a.account);
    // Who may manage members is asked first, so the account check reveals nothing to others.
    await ctx.call({ op: 'repo_members' });
    const found = await workspace(ctx.env, account, { op: 'account_exists' });
    if (found.exists !== true) throw new ApiError('NOT_FOUND', `No account named ${account}`);
    const put = await ctx.call({ op: 'repo_member_put', account, role: a.role });
    await ctx.env.INDEX.prepare(
      'INSERT INTO platform_members(repo,account,role) VALUES(?,?,?) ON CONFLICT(repo,account) DO UPDATE SET role=excluded.role',
    )
      .bind(ctx.repo, put.account, put.role)
      .run();
    await refreshHead(ctx.env, ctx.repo, true);
    return put;
  },
  git_member_remove: async (ctx: RepoContext, a: Json) => {
    const removed = await ctx.call({ op: 'repo_member_remove', account: accountArg(a.account) });
    await ctx.env.INDEX.prepare('DELETE FROM platform_members WHERE repo=? AND account=?')
      .bind(ctx.repo, removed.account)
      .run();
    await refreshHead(ctx.env, ctx.repo, true);
    return removed;
  },
};

/** `GET|POST /members`, `DELETE /members/:account`. */
export async function membersRoute(
  ctx: RepoContext,
  method: string,
  account: string | undefined,
  body: () => Promise<Json>,
) {
  if (!account && method === 'GET') return memberOperations.git_member_list(ctx);
  if (!account && method === 'POST') return memberOperations.git_member_add(ctx, await body());
  if (account && method === 'DELETE')
    return memberOperations.git_member_remove(ctx, { account: decodeURIComponent(account) });
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}
