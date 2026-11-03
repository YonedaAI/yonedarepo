// Organizations over REST (`/api/v1/orgs…`) and the account MCP: create, show, members,
// teams and repositories. The org's authority (WorkspaceAuthority `account:<org>`) decides
// who may do what; this adapter names the calling account (`actor`), checks that invited
// accounts exist, keeps each member's org hint in their own authority (which org
// authorities to ask on their requests, org-access.ts) and drops this isolate's org access
// copies after a change, so removals reach repositories within ACCESS_MS.

import { ACCOUNT_IDENTIFIER_HELP, normalizeAccountIdentifier } from '../../shared/account';
import { auditOn, auditOrg } from './account-audit';
import { homeCell } from './account-place';
import { mergeListed } from './cell-merge';
import { acrossCells } from './cell-route';
import { cellsOn } from './cells';
import { log } from './log';
import { auditPage, auditVerify } from './platform-audit-read';
import { orgHold } from './platform-holds';
import { holdSwitch } from './platform-legal-hold';
import { forgetOrgAccess, type OrgAccess, teamKey } from './platform-org-access';
import { memberCandidates, ownerMembers, resolveOrgMember } from './platform-org-member-lookup';
import { deletedOf } from './repo-deleted';
import { ApiError, type Credentials, type Json } from './repo-ops';
import { requirePatScope } from './repo-pat';
import { withPaths } from './repo-paths';
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
  else await done.catch((e) => log.warn('org.hint_removal_failed', { error: e }));
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
    .all<{ id: string; owner: string; name: string; created_at: number }>();
  return { repos: await withPaths(env, listed.results) };
}

const orgReposAcross = (env: Env, org: string, account: string) =>
  acrossCells(
    env,
    `/api/v1/orgs/${org}/repos`,
    () => orgRepos(env, org, account),
    mergeListed<Awaited<ReturnType<typeof orgRepos>>>,
  );

/** `GET /orgs/:org/repos/deleted`: what its owners can still restore. */
async function orgDeleted(env: Env, org: string, actor: string) {
  const { role } = await orgCommand(env, org, { op: 'org_show', actor });
  if (role !== 'owner')
    throw new ApiError('FORBIDDEN', `Only an owner of ${org} sees its deleted repositories`);
  return acrossCells(
    env,
    `/api/v1/orgs/${org}/repos/deleted`,
    () => deletedOf(env, org),
    mergeListed,
  );
}

/** `DELETE /orgs/:org?confirm=<org>`: an owner retires an org that owns no repositories: none
 * the listing shows, and none being created, which only its authority can tell (`orgs.rs`).
 * Former members' hints are dropped afterwards. */
async function deleteOrg(env: Env, org: string, actor: string, confirm: string) {
  await orgCommand(env, org, { op: 'org_show', actor });
  const owned = await env.INDEX.prepare(
    'SELECT COUNT(*) AS n FROM platform_repos WHERE workspace=?',
  )
    .bind(org)
    .first<{ n: number }>();
  const inCells = await orgReposAcross(env, org, actor);
  const count = Math.max(owned?.n ?? 0, inCells.repos.length);
  if (count > 0)
    throw new ApiError(
      'CONFLICT',
      `${org} owns ${count} repositories; delete them before the organization`,
    );
  const deleted = await orgCommand(env, org, {
    op: 'org_delete',
    actor,
    confirm,
    ...holdSwitch(env),
  });
  forgetOrgAccess(org);
  await Promise.all((deleted.members as string[]).map((m) => hint(env, m, org, false)));
  return { org, deleted: true };
}

/** `/api/v1/orgs/:org/audit[/verify]`: its owners'. `run` asks the org's authority. */
async function auditRoute(
  env: Env,
  org: string,
  item: string | undefined,
  query: URLSearchParams,
  run: (command: Json) => Promise<Json>,
) {
  if (!auditOn(env)) throw new ApiError('NOT_FOUND', 'Unknown API path');
  await run({ op: 'org_audit' });
  if (!item) return auditPage(env, org, query);
  if (item === 'verify') return auditVerify(env, org, query);
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}

/** `/api/v1/orgs[/:org[/members[/:account]|/teams[/:team[/members[/:account]]]|/repos|/audit]]`.
 * A change that went through then copies the org's events to its audit log. */
export async function orgsRoute(
  env: Env,
  auth: Credentials,
  method: string,
  parts: string[],
  body: () => Promise<Json>,
  query: URLSearchParams = new URLSearchParams(),
): Promise<Json> {
  const answer = await orgRoute(env, auth, method, parts, body, query);
  if (method !== 'GET') await auditOrg(env, parts[0] ? orgArg(parts[0]) : (answer.org as string));
  return answer;
}

async function orgRoute(
  env: Env,
  auth: Credentials,
  method: string,
  parts: string[],
  body: () => Promise<Json>,
  query: URLSearchParams,
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
    const created = await orgCommand(env, org, {
      op: 'org_create',
      org,
      actor: account,
      ...(cellsOn(env) && { region: homeCell() }),
    }).catch(async (e) => {
      // A retry after the hint failed: the creator already owns it, so finish the hint.
      if (!(e instanceof ApiError && e.code === 'ALREADY_EXISTS')) throw e;
      const access = await orgCommand(env, org, { op: 'org_access', account }).catch(() => null);
      if (access?.role !== 'owner') throw e;
      return { org, role: 'owner', created_at: null };
    });
    await hint(env, account, org, true);
    forgetOrgAccess(org);
    return created;
  }
  if (!name) throw new ApiError('NOT_FOUND', 'Unknown API path');
  const org = orgArg(name);
  // The audit log and what can be restored are reads that take repo:admin.
  const change =
    !get ||
    resource === 'audit' ||
    resource === 'member-candidates' ||
    (resource === 'repos' && item === 'deleted');
  const { account: actor } = orgCaller(auth, change, org);
  const run = (command: Json) => orgCommand(env, org, { ...command, actor });
  if (resource === 'audit' && get && !sub) return auditRoute(env, org, item, query, run);
  if (!resource && get) {
    const shown = await run({ op: 'org_show' });
    return auditOn(env) ? { ...shown, audit_log: true } : shown;
  }
  if (!resource && del) return deleteOrg(env, org, actor, query.get('confirm') ?? '');
  if (resource === 'repos' && !item && get) return orgReposAcross(env, org, actor);
  if (resource === 'repos' && item === 'deleted' && !sub && get) return orgDeleted(env, org, actor);
  if (resource === 'hold' && !item) return orgHold(env, auth, org, method, run);
  if (resource === 'repos' && item && sub === 'hold' && !target)
    return orgHold(env, auth, org, method, run, item);
  if (resource === 'member-candidates' && !item && get)
    return memberCandidates(env, org, actor, query.get('q') ?? '');
  if (resource === 'members' && !item && post) {
    const { account, role } = await body();
    await ownerMembers(env, org, actor);
    const found = await resolveOrgMember(env, account);
    if (!found) throw new ApiError('NOT_FOUND', 'No account found');
    const invited = found.account;
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
