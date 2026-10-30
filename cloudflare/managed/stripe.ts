// Stripe, behind the one adapter the managed Worker uses for card billing: a customer per
// workspace, Checkout in setup mode to save a card (card data goes to Stripe's page, never
// through a Worker), the saved card's brand and last four, off-session charges for top-ups
// (one idempotency key per top-up, so a retried charge is the same charge), detaching a card,
// and verifying Stripe's signed webhooks. Configured by the STRIPE_SECRET_KEY and
// STRIPE_WEBHOOK_SECRET Worker secrets; without them card billing is off ("coming").
import type { ManagedEnv } from './config';

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Stripe's error type: `card_error` is the card's answer (a decline), not a fault here. */
    readonly type: string,
  ) {
    super(message);
  }
}

export const stripeEnabled = (env: ManagedEnv) =>
  Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);

async function call(
  env: ManagedEnv,
  method: 'GET' | 'POST',
  path: string,
  form: Record<string, string> = {},
  idempotencyKey?: string,
): Promise<Record<string, any>> {
  if (!env.STRIPE_SECRET_KEY)
    throw new StripeError('Card billing is not configured', 503, 'config');
  const base = (env.STRIPE_API_BASE ?? 'https://api.stripe.com').replace(/\/$/, '');
  const headers: Record<string, string> = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const res = await fetch(`${base}/v1${path}`, {
    method,
    headers,
    body: method === 'POST' ? new URLSearchParams(form).toString() : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok)
    throw new StripeError(
      String(body.error?.message ?? `Stripe answered HTTP ${res.status}`).slice(0, 300),
      res.status,
      String(body.error?.type ?? 'api_error'),
    );
  return body;
}

export async function createCustomer(env: ManagedEnv, workspace: string): Promise<string> {
  const customer = await call(
    env,
    'POST',
    '/customers',
    { 'metadata[workspace]': workspace },
    `customer:${workspace}`,
  );
  return String(customer.id);
}

/** A Checkout Session in setup mode: Stripe's page saves the card to `customer`. */
export async function setupSession(
  env: ManagedEnv,
  o: { customer: string; workspace: string; success_url: string; cancel_url: string },
): Promise<string> {
  const session = await call(env, 'POST', '/checkout/sessions', {
    mode: 'setup',
    customer: o.customer,
    'payment_method_types[0]': 'card',
    success_url: o.success_url,
    cancel_url: o.cancel_url,
    'metadata[workspace]': o.workspace,
    'setup_intent_data[metadata][workspace]': o.workspace,
  });
  return String(session.url);
}

/** A saved card's brand and last four digits (all the Worker keeps). */
export async function cardOf(env: ManagedEnv, paymentMethod: string) {
  const pm = await call(env, 'GET', `/payment_methods/${encodeURIComponent(paymentMethod)}`);
  return { brand: String(pm.card?.brand ?? 'card'), last4: String(pm.card?.last4 ?? '????') };
}

export async function detach(env: ManagedEnv, paymentMethod: string) {
  await call(env, 'POST', `/payment_methods/${encodeURIComponent(paymentMethod)}/detach`).catch(
    (e) => {
      // Already detached, or gone at Stripe: the card is off either way.
      if (!(e instanceof StripeError && e.status === 404)) throw e;
    },
  );
}

export type Charge = { ok: true; intent: string } | { ok: false; error: string };

/**
 * Charges `amountCents` to the saved card without the customer present. A decline is an answer
 * (`ok: false`); anything else Stripe-side throws so the queue retries the same key.
 */
export async function chargeOffSession(
  env: ManagedEnv,
  o: {
    customer: string;
    payment_method: string;
    amount_cents: number;
    workspace: string;
    key: string;
  },
): Promise<Charge> {
  try {
    const intent = await call(
      env,
      'POST',
      '/payment_intents',
      {
        amount: String(o.amount_cents),
        currency: 'usd',
        customer: o.customer,
        payment_method: o.payment_method,
        off_session: 'true',
        confirm: 'true',
        description: 'YonedaRepo agent credit top-up',
        'metadata[workspace]': o.workspace,
        'metadata[top_up]': o.key,
      },
      `${o.workspace}:${o.key}`,
    );
    if (intent.status === 'succeeded') return { ok: true, intent: String(intent.id) };
    return { ok: false, error: `The charge needs attention (${String(intent.status)})` };
  } catch (e) {
    if (e instanceof StripeError && e.type === 'card_error') return { ok: false, error: e.message };
    throw e;
  }
}

const TOLERANCE_S = 300;

async function hmacHex(secret: string, text: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stripe's `Stripe-Signature` (`t=<unix>,v1=<hex>`): an HMAC-SHA256 of `<t>.<body>` under the
 * webhook secret, within five minutes. Compared in constant time. */
export async function verifyWebhook(
  env: ManagedEnv,
  body: string,
  header: string,
  now = Date.now(),
) {
  if (!env.STRIPE_WEBHOOK_SECRET) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!Number.isSafeInteger(t) || Math.abs(now / 1000 - t) > TOLERANCE_S || !signatures.length)
    return false;
  const expected = new TextEncoder().encode(
    await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${t}.${body}`),
  );
  return signatures.some((v) => {
    const given = new TextEncoder().encode(v);
    return given.length === expected.length && crypto.subtle.timingSafeEqual(given, expected);
  });
}
