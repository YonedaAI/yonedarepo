// Who may use the admin pages and `/api/v1/admin`: an operator. That is a person's own
// browser session for an account listed in ADMIN_ACCOUNTS, or the platform's owner principal
// (`_admin`: OWNER_TOKEN or Cloudflare Access; auth.ts). Personal access tokens, repository
// tokens and anonymous callers never are. Fails closed: no list, no operator accounts.
import { ApiError, type Credentials } from './repo-ops';
import type { Env } from './types';

/** The operator accounts ADMIN_ACCOUNTS names (lower case, as account names are). */
export function adminAccounts(env: Pick<Env, 'ADMIN_ACCOUNTS'>): Set<string> {
  return new Set(
    (env.ADMIN_ACCOUNTS ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Whether `account` is an operator account (the session answer's `is_admin` hint). */
export const isAdminAccount = (env: Pick<Env, 'ADMIN_ACCOUNTS'>, account: string) =>
  adminAccounts(env).has(account.toLowerCase());

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
