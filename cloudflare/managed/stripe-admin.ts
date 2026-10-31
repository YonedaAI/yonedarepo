// Stripe for operators' billing. Refunds go out under STRIPE_REFUND_KEY, a restricted key, when
// one is set, else under STRIPE_SECRET_KEY: REFUND_MAX_USD and REFUND_DAILY_USD bound them either
// way. Reading a charge is not a refund, and uses the secret key the rest of billing does.
import type { ManagedEnv } from './config';
import { StripeError, stripeRequest } from './stripe';

export type StripeRefund = { id: string; status: string; metadata?: Record<string, string> };

function refundKey(env: ManagedEnv) {
  const key = env.STRIPE_REFUND_KEY ?? env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeError('Refunds are not configured', 503, 'config');
  return key;
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

/** A charge's workspace and top-up (Stripe copies them from the payment intent), or null for a
 * charge Stripe does not know. A dispute carries neither, so the event alone cannot say whose
 * it is. */
export async function chargeOf(env: ManagedEnv, id: string) {
  try {
    return await stripeRequest(
      env,
      env.STRIPE_SECRET_KEY,
      'GET',
      `/charges/${encodeURIComponent(id)}`,
    );
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) return null;
    throw e;
  }
}

const PAGES = 20;

/** Every page of a list, up to PAGES; `complete` says whether that was all of it. */
async function everyPage(env: ManagedEnv, path: string, query: Record<string, string>) {
  const data: Record<string, any>[] = [];
  let after = '';
  for (let page = 0; page < PAGES; page++) {
    const search = new URLSearchParams({ ...query, limit: '100' });
    if (after) search.set('starting_after', after);
    const list = await stripeRequest(env, env.STRIPE_SECRET_KEY, 'GET', `${path}?${search}`);
    data.push(...(list.data as Record<string, any>[]));
    if (!list.has_more) return { data, complete: true };
    after = String(data.at(-1)?.id ?? '');
  }
  return { data, complete: false };
}

export const customerCharges = (env: ManagedEnv, customer: string) =>
  everyPage(env, '/charges', { customer });

/** The accounts with a charge or a refund at Stripe since `since` (seconds). */
export async function activeAccounts(env: ManagedEnv, since: number) {
  const created = { 'created[gte]': String(since) };
  const [charges, refunds] = await Promise.all([
    everyPage(env, '/charges', created),
    everyPage(env, '/refunds', { ...created, 'expand[]': 'data.charge' }),
  ]);
  const accounts = [
    ...charges.data.map((c) => c.metadata?.workspace),
    ...refunds.data.map((r) => r.charge?.metadata?.workspace),
  ].filter((a): a is string => typeof a === 'string');
  return [...new Set(accounts)];
}
