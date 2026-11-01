// Accounts that are ours (D1 `platform_accounts.internal`, migration 0013) stay out of every
// figure. A point holds no account, so the choice is made when it is written: the request's
// account is noted as its credentials are checked, with no read of its own, and looked up in a
// list each isolate keeps for five minutes. Budget: docs/load-testing.md. The platform Worker
// reads the list from D1. The front Worker has no D1, so it asks the platform (RPC, on no HTTP
// route). A flag therefore reaches every isolate within ten minutes.
//
// Only accounts are known here. A repository token names none without a lookup its path must
// not gain (platform-write-origin.ts), and a signed-out reader has none: our tools mark those
// requests themselves (OWN_TRAFFIC_HEADER).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Env } from './types';

const LIST_MS = 5 * 60 * 1000;
const LIST_LIMIT = 10_000;
/** The owner token's and operators' scripts: ours, whoever runs them. */
const OPERATOR = '_admin';

type Noted = { account: string | null };
/** What of `Credentials` (repo-ops.ts) names an account. Both Workers load this module, and the
 * front Worker imports no platform module, so it says so here. */
type Named = { _pat?: { workspace: string }; _session?: { workspace: string } };
type Platform = { internalAccounts(): Promise<string[]> };

const noted = new AsyncLocalStorage<Noted>();
let held: { at: number; accounts: Set<string> } | null = null;
let reading: Promise<void> | null = null;

/** Runs a platform request with a place for `noteAccount` to leave its account. */
export const withRequestAccount = <T>(run: () => T) => noted.run({ account: null }, run);

/** Credentials were checked: the running request has this account, if they name one. */
export function noteAccount(auth: object | null) {
  const request = noted.getStore();
  if (!request || !auth) return;
  const { _pat, _session } = auth as Named;
  request.account = _pat?.workspace ?? _session?.workspace ?? request.account;
}

/** The account the running request's credentials named, or null. */
export const requestAccount = () => noted.getStore()?.account ?? null;

async function read(env: Env): Promise<string[]> {
  if (!env.INDEX) return (env.PLATFORM as unknown as Platform).internalAccounts();
  const { results } = await env.INDEX.prepare(
    'SELECT account FROM platform_accounts WHERE internal=1 LIMIT ?',
  )
    .bind(LIST_LIMIT)
    .all<{ account: string }>();
  return results.map((r) => r.account);
}

/** Refreshes the list; a failed read keeps the last one and tries again next time. */
async function refresh(env: Env, now: number) {
  if (held && now - held.at < LIST_MS) return;
  reading ??= read(env)
    .then((accounts) => {
      held = { at: now, accounts: new Set(accounts) };
    })
    .catch((e) => {
      console.warn(`internal accounts unread: ${e?.message ?? e}`);
    })
    .finally(() => {
      reading = null;
    });
  await reading;
}

/** The accounts flagged internal, as this isolate holds them; null when it has never read them. */
export async function internalAccounts(env: Env, now = Date.now()) {
  await refresh(env, now);
  return held && [...held.accounts];
}

/** Whether `account` is ours. Null when no list could be read: the caller drops its point, since
 * a lost point is acceptable and our own traffic in a figure is not. */
export async function isInternal(env: Env, account: string, now = Date.now()) {
  if (account === OPERATOR) return true;
  await refresh(env, now);
  return held ? held.accounts.has(account) : null;
}

/** An operator changed a flag: this isolate reads the list again next time. */
export function forgetInternalAccounts() {
  held = null;
}
