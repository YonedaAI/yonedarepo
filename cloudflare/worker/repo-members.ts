// Repository members: other accounts, or organizations' teams (`team:<org>/<team>`), that
// use a repository with a role (read, write, land or admin). The authority decides who may
// manage whom; this adapter checks that an invited account exists (its WorkspaceAuthority),
// grants a team by its current id (from the org's authority, so a later team reusing the
// name gets nothing), keeps the D1 membership index that lists shared repositories, and
// marks the published head stale so a change of access reaches stateless reads at once.
import { ACCOUNT_IDENTIFIER_HELP, normalizeAccountIdentifier } from '../../shared/account';
import { teamKey } from './platform-org-access';
import { refreshHead } from './repo-head';
import { ApiError, type Json, type RepoContext } from './repo-ops';
import { workspace } from './workspace';

const TEAM_ENTRY = /^team:([a-z][a-z0-9_]{2,31})\/([a-z0-9][a-z0-9_-]{0,31})$/;

function accountArg(value: unknown) {
  if (typeof value === 'string' && value.trim().startsWith('team:')) {
    if (!TEAM_ENTRY.test(value.trim()))
      throw new ApiError('INVALID_INPUT', 'A team entry is team:<org>/<team>');
    return value.trim();
  }
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
    const team = TEAM_ENTRY.exec(account);
    const found = team
      ? await workspace(ctx.env, team[1], { op: 'team_exists', team: team[2] }).catch((e) => {
          if (e?.code === 'NOT_FOUND') return { exists: false } as Json;
          throw e;
        })
      : await workspace(ctx.env, account, { op: 'account_exists' });
    if (found.exists !== true)
      throw new ApiError('NOT_FOUND', `No ${team ? 'team' : 'account'} named ${account}`);
    const key = team ? teamKey(team[1], { name: team[2], id: found.id }) : account;
    const put = await ctx.call({ op: 'repo_member_put', account: key, role: a.role });
    const index =
      'INSERT INTO platform_members(repo,account,role) VALUES(?,?,?) ON CONFLICT(repo,account) DO UPDATE SET role=excluded.role';
    await ctx.env.INDEX.batch([
      ctx.env.INDEX.prepare(index).bind(ctx.repo, put.key, put.role),
      ...(put.replaced as string[]).map((stale) =>
        ctx.env.INDEX.prepare('DELETE FROM platform_members WHERE repo=? AND account=?').bind(
          ctx.repo,
          stale,
        ),
      ),
    ]);
    await refreshHead(ctx.env, ctx.repo, true);
    return put;
  },
  git_member_remove: async (ctx: RepoContext, a: Json) => {
    const removed = await ctx.call({ op: 'repo_member_remove', account: accountArg(a.account) });
    await ctx.env.INDEX.batch(
      (removed.keys as string[]).map((key) =>
        ctx.env.INDEX.prepare('DELETE FROM platform_members WHERE repo=? AND account=?').bind(
          ctx.repo,
          key,
        ),
      ),
    );
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
