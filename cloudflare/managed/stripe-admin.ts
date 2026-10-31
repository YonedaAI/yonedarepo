// Stripe for operators' billing. Refunds go out under STRIPE_REFUND_KEY alone, a restricted key:
// an unset key stops here, it never falls back to STRIPE_SECRET_KEY. Reading a charge is not a
// refund, and uses the secret key the rest of billing does.
import type { ManagedEnv } from './config';
import { StripeError, stripeRequest } from './stripe';

export type StripeRefund = { id: string; status: string; metadata?: Record<string, string> };

function refundKey(env: ManagedEnv) {
  if (!env.STRIPE_REFUND_KEY) throw new StripeError('Refunds are not configured', 503, 'config');
  return env.STRIPE_REFUND_KEY;
}

/** The refund made for `id`, if Stripe has one. Asked before every attempt: an idempotency key
 * may be pruned after 24 hours, and a saved answer can be a 500, so the key alone does not say
 * whether a refund happened. */
export async function findRefund(
  env: ManagedEnv,
  paymentIntent: string,
  id: string,
): Promise<StripeRefund | null> {
  const query = new URLSearchParams({ payment_intent: paymentIntent, limit: '100' });
  const list = await stripeRequest(env, refundKey(env), 'GET', `/refunds?${query}`);
  return (list.data as StripeRefund[]).find((r) => r.metadata?.refund === id) ?? null;
}

/** The idempotency key names the refund alone: an account can be an email address, which
 * Stripe asks not to see in a key. */
export async function createRefund(
  env: ManagedEnv,
  o: {
    id: string;
    payment_intent: string;
    amount_cents: number;
    workspace: string;
    top_up: string;
  },
): Promise<StripeRefund> {
  const refund = await stripeRequest(
    env,
    refundKey(env),
    'POST',
    '/refunds',
    {
      payment_intent: o.payment_intent,
      amount: String(o.amount_cents),
      reason: 'requested_by_customer',
      'metadata[refund]': o.id,
      'metadata[workspace]': o.workspace,
      'metadata[top_up]': o.top_up,
    },
    `refund:${o.id}`,
  );
  return refund as StripeRefund;
}
