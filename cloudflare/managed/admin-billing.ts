// `/admin/accounts/<account>/billing/*`: what operators see of an account's billing and do to
// it, called only by the platform Worker's admin routes (which check the operator, scan the
// reason and write admin_audit) with the admin bearer. Behind ADMIN_BILLING.
import type { AdminBilling } from '../../shared/admin-billing';
import { actorOf, idOf, microOf, reasonOf } from './admin-input';
import { refund, refundDay, refundLimits, refundView } from './admin-refund';
import { BillingRefusal, removeCard, resumeAll } from './billing';
import { limitMicrousd, type ManagedEnv } from './config';
import { ledgerStub } from './ledger';

const usd = (micro: number) => micro / 1_000_000;

export const adminBillingOn = (env: ManagedEnv) => env.ADMIN_BILLING === 'on';

const usdLimit = (value: string | undefined) => {
  const micro = limitMicrousd(value);
  return micro === null ? null : usd(micro);
};

function stripeUrl(env: ManagedEnv, customer: string | null) {
  if (!customer) return null;
  const test = /_test_/.test(env.STRIPE_SECRET_KEY ?? '') ? 'test/' : '';
  return `https://dashboard.stripe.com/${test}customers/${encodeURIComponent(customer)}`;
}

async function view(env: ManagedEnv, account: string): Promise<AdminBilling> {
  const [s, usedToday] = await Promise.all([
    ledgerStub(env, account).adminState(),
    refundLimits(env).refundedOn(refundDay()),
  ]);
  const openDisputes = new Set(s.disputes.filter((d) => d.status === 'open').map((d) => d.top_up));
  return {
    workspace: account,
    balance: {
      granted_usd: usd(s.balance.granted),
      used_usd: usd(s.balance.used),
      balance_usd: usd(s.balance.balance),
    },
    customer: s.customer,
    stripe_url: stripeUrl(env, s.customer),
    card: s.card,
    auto_top_up: s.auto_top_up,
    top_up_failed: s.top_up_failed,
    paused: s.paused,
    top_ups: s.top_ups.map((t) => ({
      id: t.key,
      amount_usd: usd(t.amount),
      status: t.status,
      error: t.error,
      created_at: t.created_at,
      payment_intent: t.payment_intent,
      refunded_usd: usd(t.refunded),
      frozen_usd: usd(t.frozen),
      unspent_usd: usd(t.unspent),
      refundable_usd: t.status === 'succeeded' ? usd(t.amount - t.refunded - t.frozen) : 0,
      disputed: openDisputes.has(t.key),
    })),
    refunds: s.refunds.map(refundView),
    disputes: s.disputes.map((d) => ({
      id: d.id,
      top_up: d.top_up,
      charge: d.charge,
      amount_usd: usd(d.amount),
      frozen_usd: usd(d.frozen),
      status: d.status,
      reason: d.reason,
      opened_at: d.opened_at,
      closed_at: d.closed_at,
    })),
    refund: {
      configured: Boolean(env.STRIPE_REFUND_KEY),
      max_usd: usdLimit(env.REFUND_MAX_USD),
      daily_usd: usdLimit(env.REFUND_DAILY_USD),
      used_today_usd: usd(usedToday),
    },
  };
}

function pageOf(url: URL) {
  const before = Number(url.searchParams.get('before'));
  const limit = Number(url.searchParams.get('limit'));
  return {
    before: Number.isSafeInteger(before) && before > 0 ? before : null,
    limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50,
  };
}

const GOODWILL_MAX = 1_000_000_000;

/** `POST credit {id, usd, reason, actor}`: one grant per id, and waiting runs handed back. */
async function goodwill(env: ManagedEnv, account: string, body: Record<string, unknown>) {
  const id = idOf(body);
  const reason = reasonOf(body);
  actorOf(body);
  const amount = microOf(body.usd);
  if (amount > GOODWILL_MAX) throw new BillingRefusal('INVALID_INPUT', 'usd is at most 1000', 400);
  const granted = await ledgerStub(env, account).grant(
    `goodwill:${id}`,
    amount,
    `Goodwill: ${reason}`,
  );
  await resumeAll(env, granted.resume);
}

/** `POST pause {paused, reason, actor}`: an operator's stop on charging the card. */
async function pause(env: ManagedEnv, account: string, body: Record<string, unknown>) {
  const reason = reasonOf(body);
  const actor = actorOf(body);
  if (typeof body.paused !== 'boolean')
    throw new BillingRefusal('INVALID_INPUT', 'paused is true or false', 400);
  await ledgerStub(env, account).pauseBilling(body.paused ? { reason, by: actor } : null);
}

/** `POST <action> {reason, actor}`, each answering the account as it now stands. */
async function act(
  env: ManagedEnv,
  account: string,
  action: string | undefined,
  body: Record<string, unknown>,
) {
  if (action === 'credit') await goodwill(env, account, body);
  else if (action === 'pause') await pause(env, account, body);
  else if (action === 'auto-top-up-off' || action === 'remove-card') {
    reasonOf(body);
    actorOf(body);
    if (action === 'remove-card') await removeCard(env, account);
    else await ledgerStub(env, account).setAutoTopUp(false);
  } else throw new BillingRefusal('NOT_FOUND', 'Unknown billing path', 404);
  return view(env, account);
}

/** Routes after `/admin/accounts/<account>/billing`. */
export async function adminBilling(
  req: Request,
  env: ManagedEnv,
  account: string,
  action: string | undefined,
) {
  if (!adminBillingOn(env)) throw new BillingRefusal('NOT_FOUND', 'Not found', 404);
  const { before, limit } = pageOf(new URL(req.url));
  if (req.method === 'GET') {
    if (!action) return view(env, account);
    if (action === 'ledger') return ledgerStub(env, account).ledgerPage(before, limit);
    if (action === 'usage') return ledgerStub(env, account).usagePage(before, limit);
  }
  if (req.method === 'POST') {
    const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    return action === 'refund' ? refund(env, account, body) : act(env, account, action, body);
  }
  throw new BillingRefusal('NOT_FOUND', 'Unknown billing path', 404);
}
