// Card billing for a workspace's agents: the credit as the browser sees it (with the saved
// card and the promotional credit it unlocks), saving a card through Stripe Checkout, removing
// it, switching automatic top-up on or off, Stripe's webhooks (a saved card, a top-up's
// outcome), and the automatic top-up a low balance asks for (queued, charged off-session with
// one idempotency key per top-up).
import {
  AUTO_TOP_UP,
  type BillingState,
  type ManagedCredit,
  STARTING_CREDIT_USD,
} from '../../shared/managed-agents';
import { type ManagedEnv, promoMicrousd, type QueueMessage } from './config';
import { ledgerStub, type Paused } from './ledger';
import {
  cardOf,
  chargeOffSession,
  createCustomer,
  detach,
  setupSession,
  stripeEnabled,
  verifyWebhook,
} from './stripe';

export class BillingRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function credit(env: ManagedEnv, workspace: string): Promise<ManagedCredit> {
  const ledger = ledgerStub(env, workspace);
  const [b, billing] = await Promise.all([ledger.balance(), ledger.billing()]);
  // A workspace that never set up an agent shows the starting credit setting one up adds.
  const fresh = b.granted === 0 && b.used === 0;
  const granted = fresh ? STARTING_CREDIT_USD * 1_000_000 : b.granted;
  const left = fresh ? granted : b.balance;
  return {
    granted_usd: granted / 1e6,
    used_usd: b.used / 1e6,
    balance_usd: left / 1e6,
    paused: left <= 0,
    promo: { usd: promoMicrousd(env) / 1e6, granted: billing.promo_granted },
    card: billing.card,
    top_up_failed: billing.top_up_failed,
    auto_top_up: billing.auto_top_up,
  };
}

export async function billingState(
  env: ManagedEnv,
  workspace: string,
  usage: BillingState['usage'],
): Promise<BillingState> {
  const [c, billing] = await Promise.all([
    credit(env, workspace),
    ledgerStub(env, workspace).billing(),
  ]);
  return {
    workspace,
    credit: c,
    payment_method: billing.card,
    billing: stripeEnabled(env) ? 'stripe' : 'coming',
    auto_top_up: { ...AUTO_TOP_UP, enabled: billing.auto_top_up },
    top_ups: billing.top_ups,
    usage,
  };
}

/** `POST /billing/setup {return_path}`: a Stripe Checkout URL (setup mode) that saves a card;
 * the browser returns to `return_path` on this site, or, cancelled, to the same page without
 * its `billing` flag (so it keeps an org's `?workspace=`). */
export async function setupCard(env: ManagedEnv, req: Request, workspace: string) {
  if (!stripeEnabled(env))
    throw new BillingRefusal('NOT_CONFIGURED', 'Card billing is not set up here yet', 503);
  const body = (await req.json().catch(() => null)) as { return_path?: unknown } | null;
  const path = String(body?.return_path ?? '/settings');
  if (!/^\/(?!\/)[^\s\\]*$/.test(path))
    throw new BillingRefusal(
      'INVALID_INPUT',
      'return_path is a path on this site, like /settings',
      400,
    );
  const origin = new URL(req.url).origin;
  const cancel = new URL(path, origin);
  cancel.searchParams.delete('billing');
  const ledger = ledgerStub(env, workspace);
  let customer = (await ledger.billing()).customer;
  if (!customer) {
    customer = await createCustomer(env, workspace);
    await ledger.setCustomer(customer);
  }
  const url = await setupSession(env, {
    customer,
    workspace,
    success_url: `${origin}${path}`,
    cancel_url: `${origin}${cancel.pathname}${cancel.search}`,
  });
  return { url };
}

/** `POST /billing/card/remove`: the card is detached at Stripe and top-ups stop. */
export async function removeCard(env: ManagedEnv, workspace: string) {
  const pm = await ledgerStub(env, workspace).removeCard();
  if (pm && stripeEnabled(env)) await detach(env, pm);
}

/** `POST /billing/auto-top-up {enabled}`: automatic top-up on or off; the card stays saved. */
export async function setAutoTopUp(env: ManagedEnv, req: Request, workspace: string) {
  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== 'boolean')
    throw new BillingRefusal('INVALID_INPUT', 'enabled is true or false', 400);
  await ledgerStub(env, workspace).setAutoTopUp(body.enabled);
}

const resumeAll = async (env: ManagedEnv, resume: Paused[]) => {
  if (resume.length)
    await env.RUNS.sendBatch(
      resume.map((r) => ({ body: { kind: 'resume', repo: r.repo, run: r.run } as QueueMessage })),
    );
};

/** Queues the top-up a charge asked for (`key` from the ledger), if any. */
export async function requestTopUp(env: ManagedEnv, account: string, key: string | null) {
  if (key) await env.RUNS.send({ kind: 'topup', account, key });
}

/** The queued top-up: charged to the saved card (a retry reuses its idempotency key), then
 * credited, or recorded as failed (no further top-up until a card is saved again). */
export async function runTopUp(env: ManagedEnv, m: Extract<QueueMessage, { kind: 'topup' }>) {
  const ledger = ledgerStub(env, m.account);
  const pending = await ledger.pendingTopUp(m.key);
  if (pending?.status !== 'pending') return;
  if (!pending.customer || !pending.payment_method) {
    await ledger.topUpResult(m.key, { ok: false, error: 'No card on file' });
    return;
  }
  const charge = await chargeOffSession(env, {
    customer: pending.customer,
    payment_method: pending.payment_method,
    amount_cents: Math.round(pending.amount / 10_000),
    workspace: m.account,
    key: m.key,
  });
  const { resume } = await ledger.topUpResult(m.key, charge);
  await resumeAll(env, resume);
}

/** `POST /stripe/webhook`: Stripe's signed events. A saved card (setup_intent.succeeded) and a
 * top-up's outcome (payment_intent.succeeded / payment_failed); others are acknowledged. */
export async function stripeWebhook(req: Request, env: ManagedEnv): Promise<Response> {
  const body = await req.text();
  if (body.length > 512 * 1024)
    return Response.json({ error: { code: 'TOO_LARGE' } }, { status: 413 });
  if (!(await verifyWebhook(env, body, req.headers.get('stripe-signature') ?? '')))
    return Response.json({ error: { code: 'BAD_SIGNATURE' } }, { status: 400 });
  let event: Record<string, any>;
  try {
    event = JSON.parse(body);
  } catch {
    return Response.json({ error: { code: 'INVALID_INPUT' } }, { status: 400 });
  }
  const object = event.data?.object ?? {};
  const workspace =
    typeof object.metadata?.workspace === 'string' ? object.metadata.workspace : null;
  if (!workspace) return Response.json({ ignored: true });
  const ledger = ledgerStub(env, workspace);
  if (event.type === 'setup_intent.succeeded' && typeof object.payment_method === 'string') {
    const card = await cardOf(env, object.payment_method);
    const added = await ledger.addCard(
      String(object.customer ?? ''),
      { payment_method: object.payment_method, ...card },
      promoMicrousd(env),
    );
    await resumeAll(env, added.resume);
    return Response.json({ recorded: added.recorded });
  }
  const key = typeof object.metadata?.top_up === 'string' ? object.metadata.top_up : null;
  if (key && event.type === 'payment_intent.succeeded') {
    await resumeAll(
      env,
      (await ledger.topUpResult(key, { ok: true, intent: String(object.id) })).resume,
    );
    return Response.json({ recorded: true });
  }
  if (key && event.type === 'payment_intent.payment_failed') {
    const error = String(object.last_payment_error?.message ?? 'The charge failed');
    await ledger.topUpResult(key, { ok: false, error });
    return Response.json({ recorded: true });
  }
  return Response.json({ ignored: true });
}
