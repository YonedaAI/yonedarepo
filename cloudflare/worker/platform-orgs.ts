// Organizations over REST (`/api/v1/orgs…`) and the account MCP: create, show, members,
// teams and repositories. The org's authority (WorkspaceAuthority `account:<org>`) decides
// who may do what; this adapter names the calling account (`actor`), checks that invited
// accounts exist, keeps each member's org hint in their own authority (which org
// authorities to ask on their requests, org-access.ts) and drops this isolate's org access
// copies after a change, so removals reach repositories within ACCESS_MS.
import { ACCOUNT_IDENTIFIER_HELP, normalizeAccountIdentifier } from '../../shared/account';
import { forgetOrgAccess, type OrgAccess, teamKey } from './platform-org-access';
import { ApiError, type Credentials, type Json } from './repo-ops';
import { requirePatScope } from './repo-pat';
import type { Env } from './types';
import { workspace } from './workspace';

export const ORG_NAME = /^[a-z][a-z0-9_]{2,31}$/;
const TEAM_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** An org name as its authority is addressed by, or INVALID_INPUT. */
export function orgArg(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!ORG_NAME.test(name))
    throw new ApiError(
      'INVALID_INPUT',
      'Organization names are 3-32 characters of a-z, 0-9 and _, starting with a letter',
    );
  return name;
}
function teamArg(value: unknown): string {
  if (typeof value !== 'string' || !TEAM_NAME.test(value))
    throw new ApiError(
      'INVALID_INPUT',
      'Team names are 1-32 characters of a-z, 0-9, _ and -, starting with a letter or digit',
    );
  return value;
}
function accountArg(value: unknown): string {
  const account = typeof value === 'string' ? normalizeAccountIdentifier(value) : null;
  if (!account) throw new ApiError('INVALID_INPUT', ACCOUNT_IDENTIFIER_HELP);
  return account;
}

/** An org authority's answer, with its refusals as API errors. */
export async function orgCommand(env: Env, org: string, command: Json): Promise<Json> {
  return workspace(env, org, command).catch((e) => {
    if (typeof e?.code === 'string') throw new ApiError(e.code, e.message);
    throw e;
  });
}

/** The calling person's account and resolved org access (never a repository token or an
 * operator bearer). A personal token needs repo:read to look and repo:admin to change, and
 * one limited to an org reaches only that org. */
export function orgCaller(
  auth: Credentials,
  change: boolean,
  org?: string,
): { account: string; orgs?: OrgAccess } {
  if ('_pat' in auth) {
    requirePatScope(auth, change ? 'repo:admin' : 'repo:read');
    if (auth._pat.org && auth._pat.org !== org)
      throw new ApiError('FORBIDDEN', `This token is limited to the ${auth._pat.org} organization`);
    return { account: auth._pat.workspace, orgs: auth._pat.orgs };
  }
  if ('_session' in auth && auth._session.principal === `user:${auth._session.workspace}`)
    return { account: auth._session.workspace, orgs: auth._session.orgs };
  throw new ApiError('FORBIDDEN', 'Organizations are for signed-in accounts');
}

/** Keeps `account`'s hint of `org` (added after it joined, removed after it left). */
async function hint(env: Env, account: string, org: string, add: boolean) {
  const op = add ? 'org_hint_add' : 'org_hint_remove';
  const done = workspace(env, account, { op, org });
  // A stale hint costs one lookup that grants nothing, so a failed removal only logs.
  if (add) await done;
  else await done.catch((e) => console.warn(`org hint removal failed: ${e?.message ?? e}`));
}

/** The repositories of `org` its caller can see: all for an owner, otherwise those shared
 * with the caller or one of its teams. */
async function orgRepos(env: Env, org: string, account: string) {
  const shown = await orgCommand(env, org, { op: 'org_show', actor: account });
  const keys = [
    account,
    ...(shown.teams as Json[])
      .filter((t) => (t.members as string[]).includes(account))
      .map((t) => teamKey(org, { name: t.name, id: t.id })),
  ];
  const all = shown.role === 'owner';
  // The keys go as one JSON parameter: D1 binds at most 100 per statement.
  const listed = await env.INDEX.prepare(
    `SELECT id,name,created_at,workspace AS owner,visibility FROM platform_repos WHERE workspace=?1 ${
      all
        ? ''
        : 'AND id IN (SELECT repo FROM platform_members WHERE account IN (SELECT value FROM json_each(?2)))'
    } ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(org, ...(all ? [] : [JSON.stringify(keys)]))
    .all<Json>();
  return { repos: listed.results };
}

/** `DELETE /orgs/:org?confirm=<org>`: an owner retires an org that owns no repositories
 * (as the listing shows; a repository created meanwhile is the race documented in
 * `orgs.rs`: its name is retired with the org, so it never passes to a new owner). Former
 * members' hints are dropped afterwards. */
async function deleteOrg(env: Env, org: string, actor: string, confirm: string) {
  await orgCommand(env, org, { op: 'org_show', actor });
  const owned = await env.INDEX.prepare(
    'SELECT COUNT(*) AS n FROM platform_repos WHERE workspace=?',
  )
    .bind(org)
    .first<{ n: number }>();
  if ((owned?.n ?? 0) > 0)
    throw new ApiError(
      'CONFLICT',
      `${org} owns ${owned?.n} repositories; delete them before the organization`,
    );
  const deleted = await orgCommand(env, org, { op: 'org_delete', actor, confirm });
  forgetOrgAccess(org);
  await Promise.all((deleted.members as string[]).map((m) => hint(env, m, org, false)));
  return { org, deleted: true };
}

/** `/api/v1/orgs[/:org[/members[/:account]|/teams[/:team[/members[/:account]]]|/repos]]`. */
export async function orgsRoute(
  env: Env,
  auth: Credentials,
  method: string,
  parts: string[],
  body: () => Promise<Json>,
  query: URLSearchParams = new URLSearchParams(),
): Promise<Json> {
  const [name, resource, item, sub, target] = parts;
  const get = method === 'GET';
  const post = method === 'POST';
  const del = method === 'DELETE';
  if (!name && get) {
    // An org-limited token may list, and sees only its own org.
    const limit = '_pat' in auth ? auth._pat.org : null;
    const { orgs } = orgCaller(auth, false, limit ?? undefined);
    return {
      orgs: Object.entries(orgs ?? {})
        .filter(([org]) => !limit || org === limit)
        .map(([org, a]) => ({ org, role: a.role })),
    };
  }
  if (!name && post) {
    if ('_pat' in auth && auth._pat.org)
      throw new ApiError('FORBIDDEN', 'An organization-limited token cannot create orgs');
    const { account } = orgCaller(auth, true);
    const org = orgArg((await body()).name);
    const created = await orgCommand(env, org, { op: 'org_create', org, actor: account }).catch(
      async (e) => {
        // A retry after the hint failed: the creator already owns it, so finish the hint.
        if (!(e instanceof ApiError && e.code === 'ALREADY_EXISTS')) throw e;
        const access = await orgCommand(env, org, { op: 'org_access', account }).catch(() => null);
        if (access?.role !== 'owner') throw e;
        return { org, role: 'owner', created_at: null };
      },
    );
    await hint(env, account, org, true);
    forgetOrgAccess(org);
    return created;
  }
  if (!name) throw new ApiError('NOT_FOUND', 'Unknown API path');
  const org = orgArg(name);
  const change = !get;
  const { account: actor } = orgCaller(auth, change, org);
  const run = (command: Json) => orgCommand(env, org, { ...command, actor });
  if (!resource && get) return run({ op: 'org_show' });
  if (!resource && del) return deleteOrg(env, org, actor, query.get('confirm') ?? '');
  if (resource === 'repos' && !item && get) return orgRepos(env, org, actor);
  if (resource === 'members' && !item && post) {
    const { account, role } = await body();
    const invited = accountArg(account);
    // Who may manage members is asked first, so the account check reveals nothing to others.
    await run({ op: 'org_show' });
    const found = await workspace(env, invited, { op: 'account_exists' });
    if (found.exists !== true) throw new ApiError('NOT_FOUND', `No account named ${invited}`);
    const put = await run({ op: 'org_member_put', account: invited, role });
    await hint(env, invited, org, true);
    forgetOrgAccess(org, invited);
    return put;
  }
  if (resource === 'members' && item && !sub && del) {
    const account = accountArg(decodeURIComponent(item));
    const removed = await run({ op: 'org_member_remove', account });
    forgetOrgAccess(org, account);
    await hint(env, account, org, false);
    return removed;
  }
  if (resource === 'teams' && !item && post)
    return run({ op: 'team_create', team: teamArg((await body()).name) });
  if (resource === 'teams' && item && !sub && del) {
    const deleted = await run({ op: 'team_delete', team: teamArg(item) });
    forgetOrgAccess(org);
    return deleted;
  }
  if (resource === 'teams' && item && sub === 'members' && !target && post) {
    const account = accountArg((await body()).account);
    const added = await run({ op: 'team_member_put', team: teamArg(item), account });
    forgetOrgAccess(org, account);
    return added;
  }
  if (resource === 'teams' && item && sub === 'members' && target && del) {
    const account = accountArg(decodeURIComponent(target));
    const removed = await run({ op: 'team_member_remove', team: teamArg(item), account });
    forgetOrgAccess(org, account);
    return removed;
  }
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}
