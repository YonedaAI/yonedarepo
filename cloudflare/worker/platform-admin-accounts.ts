// The operators' reads and actions on one account (platform-admin.ts routes and checks who asks).
// Every action writes admin_audit.
import { normalizeAccountIdentifier } from '../../shared/account';
import { accountSummary, recordAccount } from './account-index';
import { adminBillingOn, managedCredit } from './platform-admin-billing';
import { accountRowOf, audit, listRepos } from './platform-admin-queries';
import { ApiError, type Json } from './repo-ops';
import type { Env } from './types';
import { workspace } from './workspace';

export function accountParam(segment: string) {
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
export const asApi = (e: any): never => {
  throw e instanceof ApiError ? e : new ApiError(e?.code ?? 'INTERNAL', String(e?.message ?? e));
};

/** `GET accounts/<a>`: the index row, the authority's summary (with the contact email),
 * repositories, live personal token count and credit (null where the managed Worker is not
 * reachable from here). */
export async function accountDetail(env: Env, account: string) {
  const summary = await accountSummary(env, account).catch(asApi);
  if (!summary) throw new ApiError('NOT_FOUND', 'Unknown account');
  const [row, repos, tokens, credit] = await Promise.all([
    accountRowOf(env, account),
    listRepos(env, null, null, account),
    workspace(env, account, { op: 'pat_list' })
      .then((r) => (Array.isArray(r.tokens) ? r.tokens.length : 0))
      // A read that fails leaves a blank on the operator's page, not an error over the rest.
      .catch(() => null),
    managedCredit(env, 'GET', account).catch(() => null),
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

/** `POST accounts/<a>/credit {usd, note}`. */
export async function grantCredit(env: Env, actor: string, account: string, body: Json) {
  const usd = Number(body.usd);
  if (!Number.isFinite(usd) || usd <= 0 || usd > 1000)
    throw new ApiError('INVALID_INPUT', 'usd must be a positive amount up to 1000');
  const note =
    String(body.note ?? '')
      .trim()
      .slice(0, 200) || `Granted by ${actor}`;
  if (!(await accountSummary(env, account).catch(asApi)))
    throw new ApiError('NOT_FOUND', 'Unknown account');
  const granted = await managedCredit(env, 'POST', account, { usd, note });
  if (!granted)
    throw new ApiError('NOT_SUPPORTED', 'Credit grants are not configured on this platform');
  await audit(env, actor, 'account.credit', account, { usd, note, balance: granted.balance });
  return granted;
}

/** `POST accounts/<a>/suspend` or `unsuspend`: the authority first (it refuses the account's
 * credentials from then on), then the index row. An operator never suspends itself. */
export async function setSuspended(env: Env, actor: string, account: string, suspend: boolean) {
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
