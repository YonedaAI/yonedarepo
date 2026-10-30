// Card billing through Stripe (test mode, faked: no network): saving a card through Checkout
// in setup mode unlocks the promotional credit once, usage is drawn from credit, a low balance
// is topped up by an off-session charge to the card (one idempotency key per top-up), a failed
// charge stops further top-ups and is reported, and the card can be removed. No card data
// reaches the Worker: Stripe's webhook names the payment method, its brand and last four.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTO_TOP_UP } from '../../shared/managed-agents';
import type { QueueMessage } from '../../cloudflare/managed/config';
import { consume } from '../../cloudflare/managed/dispatch';
import { managedFetch } from '../../cloudflare/managed/index';
import { ledgerStub } from '../../cloudflare/managed/ledger';
import { FakeStripe, fakeGateway, type Harness, harness, newRepo, STRIPE_BASE, STRIPE_KEY, STRIPE_WEBHOOK_SECRET } from './fake';

afterEach(() => vi.restoreAllMocks());

const stripeEnv = { STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_API_BASE: STRIPE_BASE, PROMO_CREDIT_USD: '100' };
const api = (h: Harness, path: string, init: RequestInit = {}) =>
  managedFetch(
    new Request(`https://site.example.com/api/managed/workspaces/${h.platform.account}${path}`, {
      ...init,
      headers: { cookie: 'session=owner', 'content-type': 'application/json' },
    }),
    h.env,
  );
const deliver = async (h: Harness, ...bodies: QueueMessage[]) => {
  const messages = bodies.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }));
  await consume({ messages } as unknown as MessageBatch<QueueMessage>, h.env);
  return messages;
};

/** A workspace with a saved card (Checkout, then Stripe's setup_intent.succeeded). */
async function withCard(stripe = new FakeStripe()) {
  const h = harness(newRepo(), stripeEnv as never);
  fakeGateway(undefined, stripe);
  const setup = await api(h, '/billing/setup', { method: 'POST', body: JSON.stringify({ return_path: '/settings?billing=added' }) });
  expect(setup.status).toBe(200);
  const session = stripe.calls.find((c) => c.path === '/v1/checkout/sessions')!;
  const event = {
    id: 'evt_setup',
    type: 'setup_intent.succeeded',
    data: { object: { id: 'seti_1', payment_method: 'pm_card_1', customer: session.form.customer, metadata: { workspace: h.platform.account } } },
  };
  const res = await managedFetch(await stripe.webhook(event), h.env);
  expect(res.status).toBe(200);
  return { h, stripe, event };
}

describe('saving a card', () => {
  it('starts Checkout in setup mode for the workspace, with a customer made once', async () => {
    const stripe = new FakeStripe();
    const h = harness(newRepo(), stripeEnv as never);
    fakeGateway(undefined, stripe);
    const res = await api(h, '/billing/setup', { method: 'POST', body: JSON.stringify({ return_path: '/settings?billing=added' }) });
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.test/c/pay/cs_test_1' });
    await api(h, '/billing/setup', { method: 'POST', body: JSON.stringify({ return_path: '/settings' }) });
    expect(stripe.calls.filter((c) => c.path === '/v1/customers')).toHaveLength(1);
    const session = stripe.calls.find((c) => c.path === '/v1/checkout/sessions')!;
    expect(session.auth).toBe(`Bearer ${STRIPE_KEY}`);
    expect(session.form).toMatchObject({
      mode: 'setup',
      'payment_method_types[0]': 'card',
      success_url: 'https://site.example.com/settings?billing=added',
      cancel_url: 'https://site.example.com/settings',
      'metadata[workspace]': h.platform.account,
      'setup_intent_data[metadata][workspace]': h.platform.account,
    });
    for (const bad of ['//evil.example/x', 'https://evil.example/x', 'settings'])
      expect((await api(h, '/billing/setup', { method: 'POST', body: JSON.stringify({ return_path: bad }) })).status, bad).toBe(400);
  });

  it('records the card from the signed webhook and unlocks the promotional credit once', async () => {
    const { h, stripe, event } = await withCard();
    const billing = await (await api(h, '/billing')).json<any>();
    expect(billing).toMatchObject({ billing: 'stripe', payment_method: { brand: 'visa', last4: '4242' }, auto_top_up: AUTO_TOP_UP });
    expect(billing.credit).toMatchObject({ promo: { usd: 100, granted: true }, card: { brand: 'visa', last4: '4242' }, top_up_failed: null });
    expect(billing.credit.granted_usd).toBe(100);
    // The same event again (Stripe retries) grants nothing more.
    expect((await managedFetch(await stripe.webhook(event), h.env)).status).toBe(200);
    expect((await ledgerStub(h.env, h.platform.account).balance()).granted).toBe(100_000_000);
    expect(JSON.stringify(billing)).not.toContain('pm_card_1');
  });

  it('refuses an unsigned, mis-signed or stale webhook, and a card for another customer', async () => {
    const stripe = new FakeStripe();
    const h = harness(newRepo(), stripeEnv as never);
    fakeGateway(undefined, stripe);
    await api(h, '/billing/setup', { method: 'POST', body: JSON.stringify({ return_path: '/settings' }) });
    const event = { id: 'evt', type: 'setup_intent.succeeded', data: { object: { id: 'seti', payment_method: 'pm_x', customer: 'cus_someone_else', metadata: { workspace: h.platform.account } } } };
    const unsigned = new Request('https://managed.example.com/stripe/webhook', { method: 'POST', body: JSON.stringify(event) });
    expect((await managedFetch(unsigned, h.env)).status).toBe(400);
    expect((await managedFetch(await stripe.webhook(event, { secret: 'whsec_wrong' }), h.env)).status).toBe(400);
    expect((await managedFetch(await stripe.webhook(event, { at: Date.now() - 600_000 }), h.env)).status).toBe(400);
    expect((await managedFetch(await stripe.webhook(event), h.env)).status).toBe(200);
    expect((await (await api(h, '/billing')).json<any>()).payment_method).toBeNull();
  });

  it('reports card billing as coming, and refuses set-up, where Stripe is not configured', async () => {
    const h = harness();
    const billing = await (await api(h, '/billing')).json<any>();
    expect(billing).toMatchObject({ billing: 'coming', payment_method: null });
    expect((await api(h, '/billing/setup', { method: 'POST', body: JSON.stringify({ return_path: '/settings' }) })).status).toBe(503);
  });
});

describe('automatic top-up', () => {
  /** Spends the balance down to just under the threshold. */
  async function spendBelowThreshold(h: Harness) {
    const ledger = ledgerStub(h.env, h.platform.account);
    const left = (await ledger.balance()).balance;
    const spend = left - (AUTO_TOP_UP.below_usd * 1_000_000 - 1000);
    const meta = { repo: h.platform.repo, run: 'r', agent: 'code-review', model: 'm' };
    await ledger.hold('spend', spend, meta);
    return ledger.settle('spend', null, true, meta);
  }

  it('charges the saved card once per top-up when the balance falls below the threshold', async () => {
    const { h, stripe } = await withCard();
    const due = await spendBelowThreshold(h);
    expect(due).toMatch(/^topup-\d+$/);
    // A second charge while that top-up is pending asks for no other.
    const ledger = ledgerStub(h.env, h.platform.account);
    const meta = { repo: h.platform.repo, run: 'r2', agent: 'code-review', model: 'm' };
    await ledger.hold('more', 1000, meta);
    expect(await ledger.settle('more', null, true, meta)).toBeNull();
    const message: QueueMessage = { kind: 'topup', account: h.platform.account, key: due as string };
    await deliver(h, message, message);
    // The repeated message finds the top-up settled and charges nothing; a retry after a lost
    // answer would reuse the same idempotency key, so Stripe answers the same charge.
    const charges = stripe.calls.filter((c) => c.path === '/v1/payment_intents');
    expect(charges).toHaveLength(1);
    expect(charges[0].form).toMatchObject({ amount: String(AUTO_TOP_UP.add_usd * 100), currency: 'usd', payment_method: 'pm_card_1', off_session: 'true', confirm: 'true' });
    expect(charges[0].idempotency).toBe(`${h.platform.account}:${due}`);
    const billing = await (await api(h, '/billing')).json<any>();
    expect(billing.top_ups).toEqual([expect.objectContaining({ id: due, amount_usd: AUTO_TOP_UP.add_usd, status: 'succeeded', error: null })]);
    expect(billing.credit.granted_usd).toBe(100 + AUTO_TOP_UP.add_usd);
  });

  it('a declined charge is reported, stops further top-ups, and a new card clears it', async () => {
    const { h, stripe } = await withCard();
    stripe.decline = true;
    const due = await spendBelowThreshold(h);
    const [message] = await deliver(h, { kind: 'topup', account: h.platform.account, key: due as string });
    expect(message.ack).toHaveBeenCalled();
    let billing = await (await api(h, '/billing')).json<any>();
    expect(billing.credit.top_up_failed).toBe('Your card was declined.');
    expect(billing.top_ups[0]).toMatchObject({ status: 'failed', error: 'Your card was declined.' });
    // No automatic retry against a card that was declined.
    const ledger = ledgerStub(h.env, h.platform.account);
    const meta = { repo: h.platform.repo, run: 'r3', agent: 'code-review', model: 'm' };
    await ledger.hold('again', 1000, meta);
    expect(await ledger.settle('again', null, true, meta)).toBeNull();
    // Saving a card again (Stripe's setup_intent.succeeded) clears the failure.
    stripe.decline = false;
    const session = stripe.calls.find((c) => c.path === '/v1/checkout/sessions')!;
    const event = { id: 'evt_2', type: 'setup_intent.succeeded', data: { object: { id: 'seti_2', payment_method: 'pm_card_2', customer: session.form.customer, metadata: { workspace: h.platform.account } } } };
    await managedFetch(await stripe.webhook(event), h.env);
    billing = await (await api(h, '/billing')).json<any>();
    expect(billing.credit.top_up_failed).toBeNull();
    expect(billing.credit.granted_usd).toBe(100);
  });

  it('a top-up confirmed later by Stripe’s webhook is credited once', async () => {
    const { h, stripe } = await withCard();
    const due = (await spendBelowThreshold(h)) as string;
    await deliver(h, { kind: 'topup', account: h.platform.account, key: due });
    const intent = [...stripe.intents.values()][0];
    const event = { id: 'evt_pi', type: 'payment_intent.succeeded', data: { object: { id: intent.id, amount: intent.amount, metadata: { workspace: h.platform.account, top_up: due } } } };
    expect((await managedFetch(await stripe.webhook(event), h.env)).status).toBe(200);
    expect((await (await api(h, '/billing')).json<any>()).credit.granted_usd).toBe(100 + AUTO_TOP_UP.add_usd);
  });

  it('removing the card detaches it at Stripe and stops top-ups', async () => {
    const { h, stripe } = await withCard();
    const removed = await (await api(h, '/billing/card/remove', { method: 'POST', body: '{}' })).json<any>();
    expect(stripe.detached).toEqual(['pm_card_1']);
    expect(removed).toMatchObject({ payment_method: null, credit: { card: null, promo: { granted: true } } });
    expect(await spendBelowThreshold(h)).toBeNull();
  });
});
