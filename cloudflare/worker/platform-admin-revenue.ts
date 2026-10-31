// `/api/v1/admin/revenue`: platform-wide money for operators, behind `ADMIN_BILLING`. The numbers
// are the managed agents Worker's, from its own D1, asked for like credit with its bearer kept
// here: this Worker holds no billing data. The rebuild is here because only the platform knows
// the accounts.

import { managed } from './platform-admin-billing';
import { audit } from './platform-admin-queries';
import type { Json } from './repo-ops';
import type { Env } from './types';

const REBUILD_PAGE = 100;

/** `GET revenue?from=&to=&by=`: the managed Worker checks the range. */
export function revenue(env: Env, query: URLSearchParams) {
  return managed(env, 'GET', `/admin/billing/revenue${query.size ? `?${query}` : ''}`);
}

/** `POST revenue/rebuild {after}`: one page of accounts, personal and those that own repositories
 * (an org is a billed account too), asked to push their ledgers again. It wakes each of them, so
 * it is for the first use and for repairs, never for a page load. */
export async function rebuildRollup(env: Env, actor: string, body: Json) {
  const after = typeof body.after === 'string' ? body.after : '';
  const { results } = await env.INDEX.prepare(
    `SELECT account FROM (SELECT account FROM platform_accounts
       UNION SELECT workspace AS account FROM platform_repos)
     WHERE account>? ORDER BY account LIMIT ?`,
  )
    .bind(after, REBUILD_PAGE)
    .all<{ account: string }>();
  const accounts = results.map((r) => r.account);
  if (accounts.length) await managed(env, 'POST', '/admin/billing/rollup', { accounts });
  const answer = {
    queued: accounts.length,
    next: accounts.length === REBUILD_PAGE ? (accounts.at(-1) ?? null) : null,
  };
  await audit(env, actor, 'billing.rollup_rebuild', after || '-', answer);
  return answer;
}
