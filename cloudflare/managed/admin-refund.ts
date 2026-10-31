// Refunding a top-up, as one operation over Stripe and the ledger that a crash cannot split. The
// daily limit is reserved, the intent is recorded with its credit taken and an alarm armed (all
// in the ledger), and only then is Stripe asked. Whatever stops that, `runRefund` finishes it:
// it asks Stripe whether the refund exists, makes it under one idempotency key if not, and
// settles from the answer. It runs inline, from the queue after the alarm, and on the webhook.
import type { AdminRefund } from '../../shared/admin-billing';
import { actorOf, idOf, microOf, reasonOf } from './admin-input';
import { BillingRefusal, resumeAll } from './billing';
import { limitMicrousd, type ManagedEnv } from './config';
import { ledgerStub } from './ledger';
import type { RefundRow } from './ledger-refunds';
import { StripeError } from './stripe';
import { createRefund, findRefund } from './stripe-admin';

/** A ledger instance that holds no account's credit: `:` is in no account identifier. It
 * serialises the daily limit across accounts, which no one account's ledger can. */
const LIMITS_LEDGER = 'billing:refund-limits';

export const refundLimits = (env: ManagedEnv) =>
  env.LEDGER.get(env.LEDGER.idFromName(LIMITS_LEDGER));

/** The UTC day a refund counts toward. */
export const refundDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export const refundView = (r: RefundRow): AdminRefund => ({
  id: r.id,
  top_up: r.top_up,
  amount_usd: r.amount / 1_000_000,
  status: r.status,
  origin: r.origin,
  actor: r.actor,
  reason: r.reason,
  spent_override: r.spent_override !== 0,
  stripe_refund: r.stripe_refund,
  error: r.error,
  created_at: r.created_at,
  settled_at: r.settled_at,
});

/** Stripe's refusal, as opposed to a fault: nothing was refunded and a retry would not change
 * that. A 409 is a request still running under the key, and a 429 is a pace: both go again. */
const refused = (e: unknown): e is StripeError =>
  e instanceof StripeError &&
  e.status >= 400 &&
  e.status < 500 &&
  e.status !== 409 &&
  e.status !== 429;

async function fail(env: ManagedEnv, account: string, id: string, error: string) {
  const { resume } = await ledgerStub(env, account).refundFailed(id, error);
  await refundLimits(env).releaseRefund(id);
  await resumeAll(env, resume);
}

/** Takes an open refund as far as Stripe lets it; throws when the outcome is still unknown
 * (the alarm tries again). Stripe's own view is read first, so no path refunds twice. */
export async function runRefund(env: ManagedEnv, account: string, id: string) {
  const ledger = ledgerStub(env, account);
  const refund = await ledger.refund(id);
  if (refund?.status !== 'open' || !refund.payment_intent) return;
  let answer = await findRefund(env, refund.payment_intent, id);
  if (!answer) {
    try {
      answer = await createRefund(env, {
        id,
        payment_intent: refund.payment_intent,
        amount_cents: refund.amount / 10_000,
        workspace: account,
        top_up: refund.top_up,
      });
    } catch (e) {
      if (!refused(e)) throw e;
      await fail(env, account, id, e.message);
      return;
    }
  }
  if (answer.status === 'succeeded') await ledger.refundSucceeded(id, answer.id);
  else if (answer.status === 'failed' || answer.status === 'canceled')
    await fail(env, account, id, `Stripe says the refund ${answer.status}`);
  else await ledger.refundAccepted(id, answer.id);
}

/** `POST /admin/accounts/<account>/billing/refund {id, top_up, usd, reason, actor,
 * spent_override?, allow_negative?}`. `id` is the caller's: the same one is the same refund. */
export async function refund(env: ManagedEnv, account: string, body: Record<string, unknown>) {
  if (!env.STRIPE_REFUND_KEY)
    throw new BillingRefusal('NOT_CONFIGURED', 'Refunds are not set up here', 503);
  const max = limitMicrousd(env.REFUND_MAX_USD);
  const daily = limitMicrousd(env.REFUND_DAILY_USD);
  if (max === null || daily === null)
    throw new BillingRefusal('REFUND_LIMIT', 'Refund limits are not set', 403);
  const id = idOf(body);
  const amount = microOf(body.usd);
  const top_up = String(body.top_up ?? '');
  if (!/^topup-\d+$/.test(top_up))
    throw new BillingRefusal('INVALID_INPUT', 'top_up names a top-up', 400);
  const ask = {
    id,
    account,
    top_up,
    amount,
    reason: reasonOf(body),
    actor: actorOf(body),
    spent_override: body.spent_override === true,
    allow_negative: body.allow_negative === true,
  };
  if (amount > max)
    throw new BillingRefusal('REFUND_LIMIT', 'That is over the limit per refund', 403);
  const ledger = ledgerStub(env, account);
  const limits = refundLimits(env);
  const seen = await ledger.refund(id);
  if (!seen && !(await limits.reserveRefund(id, amount, daily, refundDay())))
    throw new BillingRefusal('REFUND_LIMIT', 'That is over the daily refund limit', 403);
  const answer = await ledger.refundIntent(ask);
  if (!answer.ok) {
    if (!seen) await limits.releaseRefund(id);
    throw new BillingRefusal(answer.code, answer.message, answer.status);
  }
  try {
    await runRefund(env, account, id);
  } catch (e: any) {
    // Recorded and armed: the answer is `open`, and the alarm finishes it.
    console.error(
      JSON.stringify({ event: 'billing.refund', message: String(e?.message ?? e).slice(0, 200) }),
    );
  }
  const now = await ledger.refund(id);
  if (!now) throw new BillingRefusal('INTERNAL', 'The refund record is missing', 500);
  return { refund: refundView(now), balance: await ledger.balance() };
}
