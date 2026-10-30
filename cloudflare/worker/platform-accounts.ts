// The operators' account index (D1 `platform_accounts`, migration 0009), platform side: a new
// account's row, its sign-up notice and welcome jobs (the entrypoint's `accountCreated`), the
// last-seen day a session check keeps, and the backfill of accounts made before the index.
// A rebuildable projection: each account's authority holds what a row repeats.
import { afterAnswer } from './background';
import { queueWelcome } from './platform-email-verify';
import type { Env, Json } from './types';
import { workspace } from './workspace';

/** How an account signed up: a password (an email address) or a sign-in provider. */
export type SignupProvider = 'email' | 'github' | 'google';
export type AccountCreated = { provider?: SignupProvider; welcome?: boolean };
const PROVIDERS: readonly string[] = ['email', 'github', 'google'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** The handle an account's name is (an email-named account picks one later). */
const ownHandle = (account: string) => (account.includes('@') ? null : account);

/** Writes `account`'s row once (a repeat keeps the first). */
export async function recordAccount(
  env: Env,
  account: string,
  provider: string,
  createdAt: number,
) {
  await env.INDEX.prepare(
    'INSERT OR IGNORE INTO platform_accounts(account,created_at,provider,handle,email_named) VALUES(?,?,?,?,?)',
  )
    .bind(account, createdAt, provider, ownHandle(account), account.includes('@') ? 1 : 0)
    .run();
}

/**
 * A new account (the entrypoint's `accountCreated`): its index row and the operators'
 * sign-up notice, then its welcome email unless it has no address. An older front Worker
 * names no details: a password sign-up's provider is then unknown, and it asked only for
 * accounts with an address.
 */
export async function accountCreated(env: Env, account: string, details: AccountCreated = {}) {
  const provider =
    details.provider && PROVIDERS.includes(details.provider) ? details.provider : 'email';
  await recordAccount(env, account, provider, Date.now());
  await env.PLATFORM_QUEUE.send({
    v: 1,
    kind: SIGNUP_NOTICE,
    repo_id: '',
    job_id: account,
    workspace: account,
  });
  if (details.welcome !== false) await queueWelcome(env, account);
}
export const SIGNUP_NOTICE = 'admin_signup_notice';

/** The day each account was last noted as seen by this isolate (one write per day each). */
const seen = new Map<string, number>();
/** Notes `account` as seen today, after the answer; at most one D1 write per account and
 * day per isolate, and none where the index is not bound (the front Worker). */
export function noteSeen(env: Env, account: string, now = Date.now()) {
  const day = Math.floor(now / DAY_MS);
  if (!env.INDEX || seen.get(account) === day) return;
  seen.set(account, day);
  if (seen.size > 10_000) seen.clear();
  void afterAnswer(() =>
    env.INDEX.prepare(
      'UPDATE platform_accounts SET last_seen_at=? WHERE account=? AND (last_seen_at IS NULL OR last_seen_at<?)',
    )
      .bind(now, account, day * DAY_MS)
      .run()
      .catch(() => seen.delete(account)),
  );
}

/** Account names the platform's other projections know (repository owners, handles,
 * members, token holders), after `after` in order. Organizations are among them; their
 * authorities answer no summary, so the backfill leaves them out. */
const KNOWN = `SELECT account FROM (
  SELECT workspace AS account FROM platform_repos UNION SELECT workspace FROM platform_handles
  UNION SELECT account FROM platform_members UNION SELECT workspace FROM platform_tokens
) WHERE account>? ORDER BY account LIMIT ?`;

/**
 * One page of the backfill: each known account without a row gets one from its authority's
 * summary (creation time, first provider). Repeating it adds nothing; `next` is the cursor
 * of the following page, null after the last. Accounts with no repository, handle,
 * membership or token are found only as they sign up.
 */
export async function backfillAccounts(env: Env, after = '', limit = 50) {
  const { results } = await env.INDEX.prepare(KNOWN).bind(after, limit).all<{ account: string }>();
  const names = results.map((r) => r.account);
  const held = names.length
    ? await env.INDEX.prepare(
        `SELECT account FROM platform_accounts WHERE account IN (${names.map(() => '?').join(',')})`,
      )
        .bind(...names)
        .all<{ account: string }>()
    : { results: [] };
  const known = new Set(held.results.map((r) => r.account));
  let added = 0;
  for (const name of names.filter((n) => !known.has(n))) {
    const summary = await accountSummary(env, name);
    if (!summary) continue; // an organization, or no such account
    await recordAccount(
      env,
      name,
      summary.providers?.[0] ?? 'email',
      Number(summary.created_at ?? 0),
    );
    if (summary.suspended_at)
      await env.INDEX.prepare('UPDATE platform_accounts SET suspended_at=? WHERE account=?')
        .bind(summary.suspended_at, name)
        .run();
    added++;
  }
  return {
    scanned: names.length,
    added,
    next: names.length === limit ? (names.at(-1) ?? null) : null,
  };
}

/** The account authority's summary, or null when `account` is no person's account. */
export async function accountSummary(env: Env, account: string): Promise<Json | null> {
  return workspace(env, account, { op: 'account_summary' }).catch((e) => {
    if (e?.code === 'NOT_FOUND') return null;
    throw e;
  });
}
