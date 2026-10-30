// The operators' account index (D1 `platform_accounts`, migration 0009), the part both Workers
// load: an account's row, its last-seen day (a no-op where the index is not bound, as in the
// front Worker) and the account authority's summary. The rest (new-account jobs, backfill) is
// platform-accounts.ts.
import { afterAnswer } from './background';
import type { Env, Json } from './types';
import { workspace } from './workspace';

/** How an account signed up: a password (an email address) or a sign-in provider. */
export type SignupProvider = 'email' | 'github' | 'google';
export type AccountCreated = { provider?: SignupProvider; welcome?: boolean };
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

/** The day each account was last noted as seen by this isolate (one write per day each). */
const seen = new Map<string, number>();
/** Notes `account` as seen today, after the answer; at most one D1 write per account and
 * day per isolate, and none where the index is not bound (the front Worker). An account the
 * index lacks (made before it, and found by no backfill) is added from its summary. */
export function noteSeen(env: Env, account: string, now = Date.now()) {
  const day = Math.floor(now / DAY_MS);
  if (!env.INDEX || seen.get(account) === day) return;
  seen.set(account, day);
  if (seen.size > 10_000) seen.clear();
  void afterAnswer(async () => {
    try {
      const { meta } = await env.INDEX.prepare(
        'UPDATE platform_accounts SET last_seen_at=? WHERE account=? AND (last_seen_at IS NULL OR last_seen_at<?)',
      )
        .bind(now, account, day * DAY_MS)
        .run();
      if (meta.changes) return;
      const held = await env.INDEX.prepare('SELECT 1 FROM platform_accounts WHERE account=?')
        .bind(account)
        .first();
      const summary = held ? null : await accountSummary(env, account);
      if (!summary) return;
      await recordAccount(
        env,
        account,
        summary.providers?.[0] ?? 'email',
        Number(summary.created_at ?? 0),
      );
      await env.INDEX.prepare('UPDATE platform_accounts SET last_seen_at=? WHERE account=?')
        .bind(now, account)
        .run();
    } catch {
      seen.delete(account); // tried again on its next session check
    }
  });
}

/** The account authority's summary, or null when `account` is no person's account. */
export async function accountSummary(env: Env, account: string): Promise<Json | null> {
  return workspace(env, account, { op: 'account_summary' }).catch((e) => {
    if (e?.code === 'NOT_FOUND') return null;
    throw e;
  });
}
