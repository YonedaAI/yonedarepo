// Stripe's events for operators' billing, signed as Stripe signs them and idempotent as the
// rest of the webhook: a refund made in Stripe's dashboard syncs to the ledger, a dispute freezes
// its credit and stops the card being charged, and closing it resolves that.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedFetch } from '../../cloudflare/managed/index';
import { admin, browserApi, deliver, paid, refundBody, spend } from './billing-fixture';
import type { FakeCharge, FakeStripe, Harness } from './fake';

afterEach(() => vi.restoreAllMocks());

const send = async (h: Harness, stripe: FakeStripe, event: Record<string, unknown>) =>
  managedFetch(await stripe.webhook(event), h.env);
const refunded = (charge: FakeCharge) => ({
  id: `evt_${crypto.randomUUID()}`,
  type: 'charge.refunded',
  data: { object: { ...charge } },
});
const dispute = (charge: FakeCharge, type: string, extra: Record<string, unknown> = {}) => ({
  id: `evt_${crypto.randomUUID()}`,
  type,
  // Stripe puts nothing of ours on a dispute: its metadata is empty.
  data: { object: { id: 'dp_1', object: 'dispute', charge: charge.id, payment_intent: charge.payment_intent, amount: charge.amount, reason: 'fraudulent', status: 'needs_response', metadata: {}, ...extra } },
});
const state = async (h: Harness) => (await admin(h, '')).json<any>();

describe('charge.refunded', () => {
  it('syncs a dashboard refund: credit debited once, replays and all', async () => {
    const { h, stripe, ledger, charge } = await paid();
    const before = (await ledger.balance()).balance;
    stripe.dashboardRefund(charge, 700);
    const event = refunded(charge);
    expect((await send(h, stripe, event)).status).toBe(200);
    expect((await send(h, stripe, event)).status).toBe(200);
    expect((await ledger.balance()).balance).toBe(before - 7_000_000);
    const view = await state(h);
    expect(view.refunds).toEqual([expect.objectContaining({ origin: 'stripe', status: 'succeeded', amount_usd: 7, actor: 'stripe' })]);
    expect(view.top_ups[0]).toMatchObject({ refunded_usd: 7, refundable_usd: 13 });
  });

  it('adds only what is new on a second dashboard refund, in any event order', async () => {
    const { h, stripe, ledger, charge } = await paid();
    const before = (await ledger.balance()).balance;
    stripe.dashboardRefund(charge, 300);
    const first = refunded(charge);
    stripe.dashboardRefund(charge, 200);
    const second = refunded(charge);
    await send(h, stripe, second);
    await send(h, stripe, first);
    expect((await ledger.balance()).balance).toBe(before - 5_000_000);
    expect((await state(h)).refunds).toHaveLength(1);
  });

  it('takes credit past zero when the money has already left, and says so on the ledger', async () => {
    const { h, stripe, ledger, charge } = await paid();
    await spend(h, 'nearly-all', 24_000_000);
    stripe.dashboardRefund(charge, 2000);
    await send(h, stripe, refunded(charge));
    expect((await ledger.balance()).balance).toBeLessThan(0);
  });

  it('does not debit an operator’s refund a second time', async () => {
    const { h, stripe, ledger, key, charge } = await paid();
    const before = (await ledger.balance()).balance;
    await admin(h, '/refund', refundBody(key, 5));
    await send(h, stripe, refunded(charge));
    expect((await ledger.balance()).balance).toBe(before - 5_000_000);
    expect((await state(h)).refunds).toHaveLength(1);
  });

  it('settles an open refund whose answer was lost, and not twice', async () => {
    const { h, stripe, ledger, key, charge } = await paid();
    const before = (await ledger.balance()).balance;
    stripe.loseRefundAnswer = true;
    const body = refundBody(key, 5);
    await admin(h, '/refund', body);
    expect((await state(h)).refunds[0].status).toBe('open');
    await send(h, stripe, refunded(charge));
    expect(h.sent).toContainEqual({ kind: 'refund', account: h.platform.account, id: body.id });
    await deliver(h, { kind: 'refund', account: h.platform.account, id: body.id });
    expect((await state(h)).refunds).toEqual([expect.objectContaining({ id: body.id, status: 'succeeded' })]);
    expect((await ledger.balance()).balance).toBe(before - 5_000_000);
  });

  it('picks up a dashboard refund hidden behind an open refund that then fails', async () => {
    const { h, stripe, ledger, key, charge } = await paid();
    const before = (await ledger.balance()).balance;
    // The operator's $5 is recorded; the dashboard refunds $5 before it reaches Stripe.
    const answer = await ledger.refundIntent({ id: 'opened-refund', account: h.platform.account, top_up: key, amount: 5_000_000, reason: 'r', actor: 'boss', spent_override: false, allow_negative: false });
    expect(answer.ok).toBe(true);
    stripe.dashboardRefund(charge, 500);
    await send(h, stripe, refunded(charge));
    expect((await ledger.balance()).balance).toBe(before - 5_000_000);
    stripe.refundError = { status: 400, type: 'invalid_request_error', message: 'Refused' };
    await deliver(h, { kind: 'refund', account: h.platform.account, id: 'opened-refund' });
    expect((await ledger.balance()).balance).toBe(before - 5_000_000);
    expect((await state(h)).refunds.map((r: any) => [r.origin, r.status]).sort()).toEqual([['operator', 'failed'], ['stripe', 'succeeded']]);
  });

  it('ignores a charge that is not ours', async () => {
    const { h, stripe, ledger, charge } = await paid();
    const before = (await ledger.balance()).balance;
    const res = await send(h, stripe, refunded({ ...charge, metadata: {} }));
    expect(await res.json()).toEqual({ ignored: true });
    const unknown = await send(h, stripe, refunded({ ...charge, amount_refunded: 500, metadata: { ...charge.metadata, top_up: 'topup-99' } }));
    expect(unknown.status).toBe(200);
    expect((await ledger.balance()).balance).toBe(before);
  });

  it('is ignored while ADMIN_BILLING is off', async () => {
    const { h, stripe, ledger, charge } = await paid({ ADMIN_BILLING: 'off' });
    const before = (await ledger.balance()).balance;
    stripe.dashboardRefund(charge, 700);
    expect(await (await send(h, stripe, refunded(charge))).json()).toEqual({ ignored: true });
    expect((await ledger.balance()).balance).toBe(before);
  });

  it('refuses a bad signature', async () => {
    const { h, stripe, ledger, charge } = await paid();
    const before = (await ledger.balance()).balance;
    stripe.dashboardRefund(charge, 700);
    expect((await managedFetch(await stripe.webhook(refunded(charge), { secret: 'whsec_wrong' }), h.env)).status).toBe(400);
    expect((await ledger.balance()).balance).toBe(before);
  });
});

describe('disputes', () => {
  it('freezes the credit and pauses auto top-up, once', async () => {
    const { h, stripe, ledger, charge } = await paid();
    const before = (await ledger.balance()).balance;
    const event = dispute(charge, 'charge.dispute.created');
    expect((await send(h, stripe, event)).status).toBe(200);
    expect((await send(h, stripe, event)).status).toBe(200);
    expect((await ledger.balance()).balance).toBe(before - 20_000_000);
    const view = await state(h);
    expect(view.disputes).toEqual([expect.objectContaining({ id: 'dp_1', status: 'open', amount_usd: 20, frozen_usd: 20, reason: 'fraudulent' })]);
    expect(view.top_ups[0]).toMatchObject({ disputed: true, frozen_usd: 20, unspent_usd: 0, refundable_usd: 0 });
    // Low balance, card on file, auto top-up on: still no charge while it is open.
    expect(await spend(h, 'low', 1_000_000)).toBeNull();
    // The customer's own switch is untouched, and they see no change.
    const billing = await (await browserApi(h, '/billing')).json<any>();
    expect(billing.auto_top_up.enabled).toBe(true);
  });

  it('freezes only what is left of the credit', async () => {
    const { h, stripe, ledger, charge } = await paid();
    await spend(h, 'most', 19_000_000);
    await send(h, stripe, dispute(charge, 'charge.dispute.created'));
    expect((await ledger.balance()).balance).toBe(0);
    expect((await state(h)).disputes[0].frozen_usd).toBeCloseTo(5.999, 2);
  });

  it('won: the credit comes back, top-ups resume, and waiting runs are handed back', async () => {
    const { h, stripe, ledger, charge } = await paid();
    const before = (await ledger.balance()).balance;
    await send(h, stripe, dispute(charge, 'charge.dispute.created'));
    await ledger.pause(h.platform.repo, 'waiting-run');
    const closed = dispute(charge, 'charge.dispute.closed', { status: 'won' });
    await send(h, stripe, closed);
    await send(h, stripe, closed);
    expect((await ledger.balance()).balance).toBe(before);
    expect((await state(h)).disputes[0]).toMatchObject({ status: 'won', frozen_usd: 20 });
    expect((await state(h)).top_ups[0]).toMatchObject({ disputed: false, frozen_usd: 0, unspent_usd: 20 });
    expect(h.sent).toContainEqual({ kind: 'resume', repo: h.platform.repo, run: 'waiting-run' });
    expect(await spend(h, 'to-threshold', (await ledger.balance()).balance - 1_000_000)).toMatch(/^topup-/);
  });

  it('lost: the frozen credit stays gone, and the top-up cannot be refunded for it', async () => {
    const { h, stripe, ledger, charge } = await paid();
    const before = (await ledger.balance()).balance;
    await send(h, stripe, dispute(charge, 'charge.dispute.created'));
    await send(h, stripe, dispute(charge, 'charge.dispute.closed', { status: 'lost' }));
    expect((await ledger.balance()).balance).toBe(before - 20_000_000);
    expect((await state(h)).top_ups[0]).toMatchObject({ disputed: false, frozen_usd: 20, refundable_usd: 0 });
  });

  it('a closed event first records it without freezing; the late created event changes nothing', async () => {
    const { h, stripe, ledger, charge } = await paid();
    const before = (await ledger.balance()).balance;
    await send(h, stripe, dispute(charge, 'charge.dispute.closed', { status: 'won' }));
    await send(h, stripe, dispute(charge, 'charge.dispute.created'));
    expect((await ledger.balance()).balance).toBe(before);
    expect((await state(h)).disputes[0]).toMatchObject({ status: 'won', frozen_usd: 0 });
  });

  it('refuses a refund while the dispute is open', async () => {
    const { h, stripe, key, charge } = await paid();
    await send(h, stripe, dispute(charge, 'charge.dispute.created'));
    const res = await admin(h, '/refund', refundBody(key, 1, { spent_override: true, allow_negative: true }));
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error.code).toBe('DISPUTED');
    expect(stripe.refunds).toHaveLength(0);
  });

  it('does not charge a top-up already queued when the dispute arrives', async () => {
    const { h, stripe, ledger, charge } = await paid();
    const key = await spend(h, 'low', (await ledger.balance()).balance - 1_000_000);
    expect(key).toMatch(/^topup-/);
    await send(h, stripe, dispute(charge, 'charge.dispute.created'));
    const before = stripe.intents.size;
    await deliver(h, { kind: 'topup', account: h.platform.account, key: key as string });
    expect(stripe.intents.size).toBe(before);
    const billing = await (await browserApi(h, '/billing')).json<any>();
    expect(billing.credit.top_up_failed).toBeNull();
  });

  it('answers 503 so Stripe redelivers, when the charge cannot be read', async () => {
    const { h, stripe, ledger, charge } = await paid();
    const before = (await ledger.balance()).balance;
    stripe.chargesDown = true;
    const event = dispute(charge, 'charge.dispute.created');
    expect((await send(h, stripe, event)).status).toBe(503);
    expect((await ledger.balance()).balance).toBe(before);
    stripe.chargesDown = false;
    expect((await send(h, stripe, event)).status).toBe(200);
    expect((await ledger.balance()).balance).toBe(before - 20_000_000);
  });

  it('ignores a dispute on a charge that is not ours, and all of them while off', async () => {
    const { h, stripe, ledger, charge } = await paid();
    const before = (await ledger.balance()).balance;
    const res = await send(h, stripe, dispute({ ...charge, id: 'ch_elsewhere' }, 'charge.dispute.created'));
    expect((await res.json<any>()).ignored).toBe(true);
    expect((await ledger.balance()).balance).toBe(before);
    const off = await paid({ ADMIN_BILLING: 'off' });
    const lookups = off.stripe.calls.length;
    expect(await (await send(off.h, off.stripe, dispute(off.charge, 'charge.dispute.created'))).json()).toEqual({ ignored: true });
    expect(off.stripe.calls).toHaveLength(lookups);
  });
});
