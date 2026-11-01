// `/api/v1/admin/*`: the operators' admin pages (admin-auth.ts says who). Reads come from the
// D1 projections (admin-queries.ts), each account's authority and the site traffic report
// (platform-site-traffic.ts). Actions are safe and reversible: credit grants (the managed agents
// Worker's admin route, its bearer kept here), suspension (the account authority refuses
// every credential until it is lifted), quarantining or releasing repository content as the
// repository's owner, and legal holds (platform-holds.ts). Refunds and the rest of billing are
// platform-admin-billing.ts. Marking an account as ours only changes what's counted. Two actions
// are not reversible: a refund, and purging a deleted
// repository now, for the live tests' teardown and dev storage. A purge is refused under a legal
// hold, and no account can ask for it: the undo window exists to survive a stolen token.
// Every action writes admin_audit.
// Contact emails appear in these answers only.
import { normalizeAccountIdentifier } from '../../shared/account';
import { accountSummary, recordAccount } from './account-index';
import { isAdminAccount } from './admin-auth';
import { backfillAccounts } from './platform-accounts';
import { adminBilling, adminBillingOn } from './platform-admin-billing';
import { setInternal } from './platform-admin-internal';
import {
  accountRowOf,
  audit,
  auditLog,
  largestRepos,
  listAccounts,
  listRepos,
  overview,
  repoRowOf,
  signups,
} from './platform-admin-queries';
import { rebuildRollup, revenue } from './platform-admin-revenue';
import { operatorOrgHold, operatorRepoHold } from './platform-holds';
import { currentHold } from './platform-legal-hold';
import { orgArg } from './platform-orgs';
import { trafficReport } from './platform-site-traffic';
import { rebuildDeleted } from './repo-deleted';
import { backfillObject } from './repo-erase';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { dispatchPurge } from './repo-projection';
import { quarantineRoute } from './repo-quarantine';
import { backfillSummaries } from './repo-search-summary';
import type { Env } from './types';
import { workspace } from './workspace';

/** The operator behind `auth` (its account, or `_admin`), or null when it is none. */
export function operatorOf(env: Env, auth: Credentials): string | null {
  if (!('_session' in auth)) return null;
  const { workspace, principal, human } = auth._session;
  if (workspace === '_admin' && principal === 'admin') return '_admin';
  if (human && principal === `user:${workspace}` && isAdminAccount(env, workspace))
    return workspace;
  return null;
}

/** The operator behind `auth`, or FORBIDDEN. */
export function requireOperator(env: Env, auth: Credentials): string {
  const operator = operatorOf(env, auth);
  if (!operator) throw new ApiError('FORBIDDEN', 'Operators only');
  return operator;
}

/** Routes after `/api/v1/admin/`. */
export async function adminRoute(
  env: Env,
  auth: Credentials,
  method: string,
  parts: string[],
  body: () => Promise<Json>,
  query: URLSearchParams,
): Promise<Json> {
  const actor = requireOperator(env, auth);
  const [section, id, action, record, sub] = parts;
  const get = method === 'GET';
  const post = method === 'POST';
  const hold = action === 'hold' && !record && (post || method === 'DELETE');
  if (section === 'overview' && !id && get)
    return { ...(await overview(env)), billing: adminBillingOn(env) };
  if (section === 'signups' && !id && get) return signups(env, query.get('since'));
  if (section === 'audit' && !id && get) return auditLog(env, query.get('before'));
  if (section === 'traffic' && !id && get) return trafficReport(env, query);
  if (section === 'backfill' && !id && post) {
    const after = (await body().catch(() => ({}) as Json)).after;
    const done = await backfillAccounts(env, typeof after === 'string' ? after : '');
    await audit(env, actor, 'accounts.backfill', after || '-', done);
    return done;
  }
  if (section === 'erase-backfill' && !id && post) return backfillObject(env, actor, await body());
  if (section === 'search-backfill' && !id && post)
    return backfillSummaries(env, actor, await body());
  if (section === 'deleted-repos' && id === 'rebuild' && !action && post)
    return rebuildSchedule(env, actor, await body());
  if (section === 'accounts' && !id && get)
    return listAccounts(env, query.get('q'), query.get('before'));
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
    if ((action === 'suspend' || action === 'unsuspend') && post)
      return setSuspended(env, actor, account, action === 'suspend');
    if (action === 'internal' && post)
      return setInternal(env, actor, account, (await body()).internal === true);
  }
  if (section === 'orgs' && id && hold) return operatorOrgHold(env, actor, orgArg(id), method);
  if (section === 'repos' && !id && get) return listRepos(env, query.get('q'), query.get('before'));
  if (section === 'repos' && id === 'largest' && !action && get) return largestRepos(env);
  if (section === 'repos' && id) {
    if (!/^r[0-9a-f]{20}$/.test(id)) throw new ApiError('NOT_FOUND', 'Unknown repository');
    if (!action && get) return repoDetail(env, id);
    if (action === 'quarantine' && post)
      return quarantineAsOwner(env, actor, id, record, sub, body);
    if (hold) return operatorRepoHold(env, actor, id, method);
    if (action === 'purge-now' && !record && post) return purgeNow(env, actor, id);
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
  await dispatchPurge(env, repo, 'now');
  await audit(env, actor, 'repo.purge_now', repo, {});
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

function accountParam(segment: string) {
  let name: string | null = null;
  try {
    name = normalizeAccountIdentifier(decodeURIComponent(segment));
  } catch {
    // not an account name
  }
  if (!name) throw new ApiError('NOT_FOUND', 'Unknown account');
  return name;
}

/** An account authority's refusal as the API's own. */
const asApi = (e: any): never => {
  throw e instanceof ApiError ? e : new ApiError(e?.code ?? 'INTERNAL', String(e?.message ?? e));
};

/** `GET accounts/<a>`: the index row, the authority's summary (with the contact email),
 * repositories, live personal token count and credit (null where the managed Worker is not
 * reachable from here). */
async function accountDetail(env: Env, account: string) {
  const summary = await accountSummary(env, account).catch(asApi);
  if (!summary) throw new ApiError('NOT_FOUND', 'Unknown account');
  const [row, repos, tokens, credit] = await Promise.all([
    accountRowOf(env, account),
    listRepos(env, null, null, account),
    workspace(env, account, { op: 'pat_list' })
      .then((r) => (Array.isArray(r.tokens) ? r.tokens.length : 0))
      .catch(() => null),
    managed(env, 'GET', account).catch(() => null),
  ]);
  return {
    account,
    indexed: Boolean(row),
    internal: row?.internal ?? false,
    handle: summary.handle ?? null,
    email: summary.email ?? null,
    providers: summary.providers ?? [],
    password: Boolean(summary.password),
    orgs: summary.orgs ?? [],
    created_at: summary.created_at ?? row?.created_at ?? null,
    last_seen_at: row?.last_seen_at ?? null,
    suspended_at: summary.suspended_at ?? null,
    repos: repos.items,
    tokens,
    credit,
    billing: adminBillingOn(env),
  };
}

/** The managed agents Worker's admin credit route for `account`; null when it is not bound
 * or has no bearer here. */
async function managed(env: Env, method: 'GET' | 'POST', account: string, body?: Json) {
  if (!env.MANAGED || !env.MANAGED_ADMIN_TOKEN) return null;
  const answer = await env.MANAGED.fetch(
    `https://managed/admin/accounts/${encodeURIComponent(account)}/credit`,
    {
      method,
      headers: {
        authorization: `Bearer ${env.MANAGED_ADMIN_TOKEN}`,
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const value = await answer.json<Json>().catch(() => ({}) as Json);
  if (!answer.ok)
    throw new ApiError(
      answer.status === 400 ? 'INVALID_INPUT' : 'PUSH_FAILED',
      value.error?.message ?? `The managed agents Worker answered ${answer.status}`,
    );
  return value;
}

/** `POST accounts/<a>/credit {usd, note}`. */
async function grantCredit(env: Env, actor: string, account: string, body: Json) {
  const usd = Number(body.usd);
  if (!Number.isFinite(usd) || usd <= 0 || usd > 1000)
    throw new ApiError('INVALID_INPUT', 'usd must be a positive amount up to 1000');
  const note =
    String(body.note ?? '')
      .trim()
      .slice(0, 200) || `Granted by ${actor}`;
  if (!(await accountSummary(env, account).catch(asApi)))
    throw new ApiError('NOT_FOUND', 'Unknown account');
  const granted = await managed(env, 'POST', account, { usd, note });
  if (!granted)
    throw new ApiError('NOT_SUPPORTED', 'Credit grants are not configured on this platform');
  await audit(env, actor, 'account.credit', account, { usd, note, balance: granted.balance });
  return granted;
}

/** `POST accounts/<a>/suspend` or `unsuspend`: the authority first (it refuses the account's
 * credentials from then on), then the index row. An operator never suspends itself. */
async function setSuspended(env: Env, actor: string, account: string, suspend: boolean) {
  if (suspend && account === actor)
    throw new ApiError('INVALID_INPUT', 'You cannot suspend your own account');
  const result = await workspace(env, account, {
    op: suspend ? 'account_suspend' : 'account_unsuspend',
  }).catch(asApi);
  if (!(await accountRowOf(env, account))) {
    const summary = await accountSummary(env, account);
    if (summary)
      await recordAccount(
        env,
        account,
        summary.providers?.[0] ?? 'email',
        Number(summary.created_at ?? 0),
        summary.region,
      );
  }
  await env.INDEX.prepare('UPDATE platform_accounts SET suspended_at=? WHERE account=?')
    .bind(result.suspended_at ?? null, account)
    .run();
  await audit(env, actor, suspend ? 'account.suspend' : 'account.unsuspend', account);
  return { account, suspended_at: result.suspended_at ?? null };
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
