import { adminRead, clearAdminReads, memoizedAdminRead } from './admin-read-cache';
import { readAdminOverview } from './platform-admin-overview';
// `/api/v1/admin/*`: the operators' admin pages (admin-auth.ts says who). Reads come from the
// D1 projections (admin-queries.ts), each account's authority and the site traffic report
// (platform-site-traffic.ts). Actions are safe and reversible: credit grants (the managed agents
// Worker's admin route, its bearer kept here), suspension (the account authority refuses
// every credential until it is lifted), quarantining or releasing repository content as the
// repository's owner, and legal holds (platform-holds.ts). Refunds and the rest of billing are
// platform-admin-billing.ts. Marking an account as ours only changes what's counted. Three actions
// are not reversible: a refund, purging a deleted repository now, for the live tests' teardown
// and dev storage, and purging an orphan (platform-orphan-purge.ts). A purge is refused under a
// legal hold; a repository's owner, signed in, has a route of their own (repo-purge.ts).
// Every action writes admin_audit.
// Contact emails appear in these answers only.

import { accountSummary } from './account-index';
import { isAdminAccount } from './admin-auth';
import { closeByOperator } from './platform-account-close-route';
import { backfillAccounts } from './platform-accounts';
import {
  accountDetail,
  accountParam,
  asApi,
  grantCredit,
  setSuspended,
} from './platform-admin-accounts';
import { adminBilling, adminBillingOn } from './platform-admin-billing';
import { everyCell, mergePages, mergeSignups } from './platform-admin-cells';
import { setInternal } from './platform-admin-internal';
import {
  audit,
  auditLog,
  largestRepos,
  listAccounts,
  listRepos,
  repoRowOf,
  signups,
} from './platform-admin-queries';
import {
  mergeRepositoryPages,
  repositoryQuery,
  sortedRepositories,
} from './platform-admin-repositories';
import { rebuildRollup, revenue } from './platform-admin-revenue';
import { agentView } from './platform-agent-report';
import { setAsideAuditRow } from './platform-audit-set-aside';
import { operatorOrgHold, operatorRepoHold } from './platform-holds';
import { infraReport } from './platform-infra-report';
import { currentHold } from './platform-legal-hold';
import { exportSubscribers } from './platform-newsletter';
import { adminReports, operationsReport } from './platform-operations-report';
import {
  auditedPurge,
  deniedAttempt,
  failedAttempt,
  operatorAudit,
  operatorLog,
  staffRead,
} from './platform-operator-audit';
import { orgArg } from './platform-orgs';
import { purgeOrphan } from './platform-orphan-purge';
import { landingReport, repoUsageReport } from './platform-repo-reports';
import { serviceLevels } from './platform-service-levels';
import { trafficReport } from './platform-site-traffic';
import { visitorReport } from './platform-visitor-report';
import { authorBackfill } from './repo-author-backfill';
import { rebuildDeleted } from './repo-deleted';
import { backfillObject } from './repo-erase';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { dispatchPurge } from './repo-projection';
import { quarantineRoute } from './repo-quarantine';
import { importAudit, reimportRepository } from './repo-reimport';
import { backfillSummaries } from './repo-search-summary';
import type { Env } from './types';

/** The operator behind `auth` (its account, or `_admin`), or null when it is none. */
export function operatorOf(env: Env, auth: Credentials): string | null {
  if (!('_session' in auth)) return null;
  const { workspace, principal, human } = auth._session;
  if (workspace === '_admin' && principal === 'admin') return '_admin';
  if (human && principal === `user:${workspace}` && isAdminAccount(env, workspace))
    return workspace;
  return null;
}

/** Routes after `/api/v1/admin/`. */
export function adminRoute(
  env: Env,
  auth: Credentials,
  method: string,
  parts: string[],
  body: () => Promise<Json>,
  query: URLSearchParams,
): Promise<Json> {
  const actor = operatorOf(env, auth);
  if (!actor) {
    void deniedAttempt(env, auth, parts[0]);
    throw new ApiError('FORBIDDEN', 'Operators only');
  }
  return operatorRoute(env, actor, method, parts, body, query)
    .then((value) => {
      if (method !== 'GET') clearAdminReads();
      return value;
    })
    .catch((e) => {
      void failedAttempt(env, actor, method, parts, e);
      throw e;
    });
}

async function operatorRoute(
  env: Env,
  actor: string,
  method: string,
  parts: string[],
  body: () => Promise<Json>,
  query: URLSearchParams,
  cacheAllowed = true,
): Promise<Json> {
  const [section, id, action, record, sub] = parts;
  const get = method === 'GET';
  if (get && cacheAllowed && memoizedAdminRead(section, id))
    return adminRead(env, actor, `/${parts.join('/')}?${query}`, () =>
      operatorRoute(env, actor, method, parts, body, query, false),
    );
  const post = method === 'POST';
  const hold = action === 'hold' && !record && (post || method === 'DELETE');
  if (section === 'overview' && !id && get) return readAdminOverview(env, actor);
  if (section === 'newsletter' && !id && get)
    return exportSubscribers(env, actor, query.get('after'));
  if (section === 'signups' && !id && get) {
    const path = `/api/v1/admin/signups?${query}`;
    const feed = await everyCell(env, path, () => signups(env, query.get('since')), mergeSignups);
    return { ...feed, reports: adminReports(env) };
  }
  if (section === 'audit' && !id && get)
    return operatorAudit(env) ? operatorLog(env, query) : auditLog(env, query.get('before'));
  if (section === 'traffic' && !id && get)
    return adminRead(env, actor, `/traffic?${query}`, () => trafficReport(env, query));
  if (section === 'traffic' && id === 'landings' && get) return landingReport(env, query);
  if (section === 'operations' && !id && get) return operationsReport(env, query);
  if (section === 'visitors' && !id && get) return visitorReport(env, query);
  if (section === 'agents' && !id && get) return agentView(env, query);
  if (section === 'infrastructure' && !id && get) return infraReport(env);
  if (section === 'backfill' && !id && post) {
    const after = (await body().catch(() => ({}) as Json)).after;
    const done = await backfillAccounts(env, typeof after === 'string' ? after : '');
    await audit(env, actor, 'accounts.backfill', after || '-', done);
    return done;
  }
  if (section === 'service-levels' && !id && get) return serviceLevels(env);
  if (section === 'erase-backfill' && !id && post) return backfillObject(env, actor, await body());
  if (section === 'search-backfill' && !id && post)
    return backfillSummaries(env, actor, await body());
  if (section === 'deleted-repos' && id === 'rebuild' && !action && post)
    return rebuildSchedule(env, actor, await body());
  if (section === 'accounts' && !id && get)
    return everyCell(
      env,
      `/api/v1/admin/accounts?${query}`,
      () => listAccounts(env, query.get('q'), query.get('before')),
      mergePages,
    );
  if (section === 'revenue' && adminBillingOn(env)) {
    if (!id && get) return revenue(env, query);
    if (id === 'rebuild' && !action && post) return rebuildRollup(env, actor, await body());
  }
  if (section === 'accounts' && id && action === 'billing' && adminBillingOn(env) && !sub) {
    const account = accountParam(id);
    if (!(await accountSummary(env, account).catch(asApi)))
      throw new ApiError('NOT_FOUND', 'Unknown account');
    return adminBilling(env, actor, account, method, record, body, query);
  }
  if (section === 'accounts' && id && !record) {
    const account = accountParam(id);
    if (!action && get) return accountDetail(env, account);
    if (action === 'credit' && post) return grantCredit(env, actor, account, await body());
    if (action === 'close' && post) return closeByOperator(env, actor, account, await body());
    if ((action === 'suspend' || action === 'unsuspend') && post)
      return setSuspended(env, actor, account, action === 'suspend');
    if (action === 'internal' && post)
      return setInternal(env, actor, account, (await body()).internal === true);
  }
  if (section === 'orgs' && id && hold) return operatorOrgHold(env, actor, orgArg(id), method);
  if (section === 'imports' && !id && get) return importAudit(env, query.get('after'));
  if (
    section === 'repos' &&
    !id &&
    get &&
    [...query.keys()].some((key) => key !== 'q' && key !== 'before')
  ) {
    const order = repositoryQuery(query);
    return everyCell(
      env,
      `/api/v1/admin/repos?${query}`,
      () => sortedRepositories(env, order),
      (parts) => mergeRepositoryPages(parts, order),
    );
  }
  if (section === 'repos' && !id && get)
    return everyCell(
      env,
      `/api/v1/admin/repos?${query}`,
      () => listRepos(env, query.get('q'), query.get('before')),
      mergePages,
    );
  if (section === 'repos' && id === 'largest' && !action && get) return largestRepos(env);
  if (section === 'repos' && id === 'usage' && !action && get) return repoUsageReport(env, query);
  if (section === 'repos' && id) {
    if (!/^r[0-9a-f]{20}$/.test(id)) throw new ApiError('NOT_FOUND', 'Unknown repository');
    if (!action && get) {
      void staffRead(env, actor, id);
      return repoDetail(env, id);
    }
    if (action === 'quarantine' && post)
      return quarantineAsOwner(env, actor, id, record, sub, body);
    if (hold) return operatorRepoHold(env, actor, id, method);
    if (action === 'audit-set-aside' && !record && post)
      return setAsideAuditRow(env, actor, id, await body());
    if (action === 'purge-now' && !record && post) return purgeNow(env, actor, id);
    if (action === 'reimport' && !record && post)
      return reimportRepository(env, actor, id, await body());
    if (action === 'author-backfill' && !record && post)
      return authorBackfill(env, actor, id, await body());
    if (action === 'purge-orphan' && !record && post)
      return purgeOrphan(env, actor, id, await body());
  }
  throw new ApiError('NOT_FOUND', 'Unknown admin path');
}

/** `POST /admin/repos/:id/purge-now`: a deleted repository's purge, without its window. One
 * whose purge has started just gets the job again; a repeat is harmless. */
async function purgeNow(env: Env, actor: string, repo: string) {
  const call = caller(env, repo, { _system: 'purge' });
  const facts = await call({ op: 'repo_restore', check: true }).catch((e) => {
    if (e?.code !== 'GONE') throw e;
    return null;
  });
  if (facts?.already) throw new ApiError('CONFLICT', 'That repository is not deleted');
  const hold = await currentHold(env, repo, call).catch((e) => {
    if (e?.code !== 'GONE') throw e;
    return 'off' as const;
  });
  if (hold !== 'off' && hold.held)
    throw new ApiError('LEGAL_HOLD', 'This repository is under a legal hold: nothing is purged');
  if (operatorAudit(env))
    await auditedPurge(env, actor, repo, () => dispatchPurge(env, repo, 'now'));
  else {
    await dispatchPurge(env, repo, 'now');
    await audit(env, actor, 'repo.purge_now', repo, {});
  }
  return { queued: true };
}

/** `POST /admin/deleted-repos/rebuild {owner}`: D1's schedule of one owner, from its records.
 * The erase backfill finds tombstones whose owner nobody can name. */
async function rebuildSchedule(env: Env, actor: string, body: Json) {
  const owner = typeof body.owner === 'string' ? body.owner : '';
  const done = await rebuildDeleted(env, owner);
  await audit(env, actor, 'repos.deleted_rebuild', owner, done);
  return done;
}

/** The repository's owner, acting through an operator: owner access, never a person's
 * (no break-glass). The repository records the `admin` principal. */
async function asOwner(env: Env, repo: string) {
  const row = await repoRowOf(env, repo);
  if (!row) throw new ApiError('NOT_FOUND', 'Unknown repository');
  const auth: Credentials = { _session: { workspace: String(row.owner), principal: 'admin' } };
  return { row, ctx: new RepoContext(env, repo, caller(env, repo, auth)) };
}

/** `GET repos/<id>`: the listing row, the repository's quarantine records and what its
 * database holds now (null when that cannot be read: the rest of the page still helps). */
async function repoDetail(env: Env, repo: string) {
  const { row, ctx } = await asOwner(env, repo);
  const [quarantines, storage] = await Promise.all([
    ctx.call({ op: 'repo_quarantines' }),
    ctx.call({ op: 'repo_storage' }).catch(() => null),
  ]);
  return { ...row, quarantines: quarantines.records ?? [], storage };
}

/** `POST repos/<id>/quarantine {blob | path (at ref) | session, reason}` or
 * `POST repos/<id>/quarantine/<record>/release`, as repo-quarantine.ts answers its owner. */
async function quarantineAsOwner(
  env: Env,
  actor: string,
  repo: string,
  record: string | undefined,
  sub: string | undefined,
  body: () => Promise<Json>,
) {
  if (record && sub !== 'release') throw new ApiError('NOT_FOUND', 'Unknown admin path');
  const { ctx } = await asOwner(env, repo);
  const args = record ? {} : await body();
  const done = await quarantineRoute(ctx, 'POST', record, sub, async () => args);
  await audit(env, actor, record ? 'repo.release' : 'repo.quarantine', repo, {
    ...(record ? { record: Number(record) } : {}),
    ...(args.reason ? { reason: String(args.reason).slice(0, 200) } : {}),
  });
  return done;
}
