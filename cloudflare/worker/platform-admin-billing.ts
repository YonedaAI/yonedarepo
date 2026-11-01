// `/api/v1/admin/accounts/:account/billing/*`: an operator's view of an account's billing and
// the actions on it, behind `ADMIN_BILLING`. `adminRoute` has already required an operator; the
// money is the managed agents Worker's (its admin routes, its bearer kept here). Each action
// needs a reason, scanned with the platform's own secret rules, and writes admin_audit before
// the money moves and again after, so a row reading `pending` is an action cut off midway. The
// actor is always the operator's session, never the body.
import { auditBegin, auditEnd } from './platform-admin-queries';
import { compute } from './repo-compute';
import { ApiError, type Json } from './repo-ops';
import type { Env } from './types';

const REASON_MAX = 500;
/** The minute of each night (UTC) the reconcile starts; the cron is every minute. */
const RECONCILE_AT = { hour: 3, minute: 17 };

export const adminBillingOn = (env: Env) => env.ADMIN_BILLING === 'on';

/** The managed Worker's answer, or its refusal as this API's own. */
export async function managed(
  env: Env,
  method: 'GET' | 'POST',
  path: string,
  body?: Json,
): Promise<Json> {
  if (!env.MANAGED || !env.MANAGED_ADMIN_TOKEN)
    throw new ApiError('NOT_CONFIGURED', 'Billing is not reachable from this platform');
  const answer = await env.MANAGED.fetch(`https://managed${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.MANAGED_ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await answer.json<Json>().catch(() => ({}) as Json);
  if (answer.ok) return value;
  const code = answer.status === 401 ? 'PUSH_FAILED' : (value.error?.code ?? 'PUSH_FAILED');
  throw new ApiError(
    code,
    value.error?.message ?? `The managed agents Worker answered ${answer.status}`,
  );
}

const billingPath = (account: string, tail = '') =>
  `/admin/accounts/${encodeURIComponent(account)}/billing${tail}`;

/** The reason an action must carry: refused here when it is missing, too long or holds what
 * looks like a credential, so nothing of it reaches the audit log or the ledger. */
function reasonOf(args: Json): string {
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (!reason) throw new ApiError('INVALID_INPUT', 'A reason is required');
  if (reason.length > REASON_MAX)
    throw new ApiError('INVALID_INPUT', `A reason is at most ${REASON_MAX} characters`);
  if (!compute({ op: 'secret_scan', text: reason }).clean)
    throw new ApiError('SECRET_DETECTED', 'That reason looks like it holds a credential');
  return reason;
}

/** What each action sends: only these fields leave here. */
const FIELDS: Record<string, (args: Json) => Json> = {
  refund: (a) => ({
    usd: a.usd,
    request: a.id,
    top_up: a.top_up,
    spent_override: a.spent_override === true,
    allow_negative: a.allow_negative === true,
  }),
  credit: (a) => ({ usd: a.usd, request: a.id }),
  'auto-top-up-off': () => ({}),
  'remove-card': () => ({}),
  pause: (a) => ({ paused: a.paused }),
};

/** The body the managed route takes: the audited fields, under the names it knows. */
function sent({ request, ...fields }: Json, reason: string, actor: string) {
  return { ...fields, ...(request ? { id: request } : {}), reason, actor };
}

/** How the action ended, for its audit row. */
function outcomeOf(done: Json) {
  return {
    outcome: done.refund?.status ?? 'done',
    ...(done.balance?.balance === undefined ? {} : { balance: done.balance.balance }),
  };
}

async function act(env: Env, actor: string, account: string, action: string, args: Json) {
  const reason = reasonOf(args);
  const fields = FIELDS[action](args);
  const detail = { reason, ...fields };
  const row = await auditBegin(env, actor, `billing.${action}`, account, {
    ...detail,
    outcome: 'pending',
  });
  const end = (outcome: Json) =>
    auditEnd(env, row, { ...detail, ...outcome }).catch((e) =>
      // The money has moved or been refused: the answer still goes back, and the row reads
      // `pending`, which is what a cut-off action reads.
      console.error(
        JSON.stringify({ event: 'billing.audit', message: String(e?.message ?? e).slice(0, 200) }),
      ),
    );
  try {
    const done = await managed(env, 'POST', billingPath(account, `/${action}`), {
      ...sent(fields, reason, actor),
    });
    await end(outcomeOf(done));
    return done;
  } catch (e: any) {
    if (e instanceof ApiError) {
      await end({ outcome: 'refused', code: e.code });
      throw e;
    }
    // No answer: a refund may be recorded there, and the ledger's alarm finishes it.
    await end({ outcome: 'unknown' });
    throw new ApiError('PUSH_FAILED', 'The managed agents Worker did not answer');
  }
}

/** Routes after `accounts/<account>/billing`. */
export async function adminBilling(
  env: Env,
  actor: string,
  account: string,
  method: string,
  action: string | undefined,
  body: () => Promise<Json>,
  query: URLSearchParams,
): Promise<Json> {
  if (method === 'GET' && (!action || action === 'ledger' || action === 'usage')) {
    const search = query.size ? `?${query}` : '';
    return managed(env, 'GET', billingPath(account, action ? `/${action}${search}` : ''));
  }
  if (method === 'POST' && action && Object.hasOwn(FIELDS, action))
    return act(env, actor, account, action, await body());
  throw new ApiError('NOT_FOUND', 'Unknown admin path');
}

/** The cron's nightly start of the read-only reconcile (managed/admin-reconcile.ts). A missed
 * minute only skips a night; a failure must not touch the rest of the cron. */
export async function nightlyReconcile(env: Env, at: number) {
  const time = new Date(at);
  if (time.getUTCHours() !== RECONCILE_AT.hour || time.getUTCMinutes() !== RECONCILE_AT.minute)
    return;
  if (!adminBillingOn(env) || !env.MANAGED || !env.MANAGED_ADMIN_TOKEN) return;
  await managed(env, 'POST', '/admin/billing/reconcile').catch((e) =>
    console.error(
      JSON.stringify({
        event: 'billing.reconcile',
        message: String(e?.message ?? e).slice(0, 200),
      }),
    ),
  );
}
