// The nightly reconcile: read-only, it compares each active account's ledger with Stripe and
// logs what differs. Behind ADMIN_BILLING.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedFetch } from '../../cloudflare/managed/index';
import { admin, deliver, paid, refundBody } from './billing-fixture';
import type { Harness } from './fake';

afterEach(() => vi.restoreAllMocks());

const trigger = (h: Harness, bearer = 'fixture-admin-token') =>
  managedFetch(
    new Request('https://managed.example.com/admin/billing/reconcile', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
    }),
    h.env,
  );

/** The mismatches the reconcile logs for the account. */
function logged() {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () =>
    spy.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line));
        } catch {
          return null;
        }
      })
      .filter((e) => e?.event === 'billing.reconcile.mismatch');
}

describe('nightly reconcile', () => {
  it('is off unless ADMIN_BILLING is on, and needs the bearer', async () => {
    const off = await paid({ ADMIN_BILLING: 'off' });
    expect((await trigger(off.h)).status).toBe(404);
    const { h } = await paid();
    expect((await trigger(h, 'wrong-token')).status).toBe(401);
    expect(h.sent.some((m) => m.kind === 'reconcile-all')).toBe(false);
  });

  it('queues the sweep, then one job per account Stripe saw activity for', async () => {
    const { h } = await paid();
    expect((await trigger(h)).status).toBe(202);
    expect(h.sent).toContainEqual({ kind: 'reconcile-all' });
    await deliver(h, { kind: 'reconcile-all' });
    expect(h.sent).toContainEqual({ kind: 'reconcile', account: h.platform.account });
  });

  it('finds an account from a refund alone, when its charge is old', async () => {
    const { h, stripe, charge } = await paid();
    charge.created = 1;
    stripe.dashboardRefund(charge, 100);
    await deliver(h, { kind: 'reconcile-all' });
    expect(h.sent).toContainEqual({ kind: 'reconcile', account: h.platform.account });
  });

  it('logs nothing when the ledger and Stripe agree, an operator’s refund included', async () => {
    const read = logged();
    const { h, key } = await paid();
    await admin(h, '/refund', refundBody(key, 5));
    await deliver(h, { kind: 'reconcile', account: h.platform.account });
    expect(read()).toEqual([]);
  });

  it('does not call an open refund a mismatch, whether or not Stripe has it yet', async () => {
    const read = logged();
    const { h, stripe, key } = await paid();
    stripe.loseRefundAnswer = true;
    await admin(h, '/refund', refundBody(key, 5));
    await deliver(h, { kind: 'reconcile', account: h.platform.account });
    expect(read()).toEqual([]);
  });

  it('logs a refund the ledger never heard of, without changing anything', async () => {
    const read = logged();
    const { h, stripe, ledger, key, charge } = await paid();
    stripe.dashboardRefund(charge, 700);
    const before = await ledger.balance();
    const calls = stripe.calls.length;
    await deliver(h, { kind: 'reconcile', account: h.platform.account });
    expect(read()).toEqual([
      expect.objectContaining({ account: h.platform.account, top_up: key, problem: 'refund_total', ledger_usd: 0, stripe_usd: 7 }),
    ]);
    expect(await ledger.balance()).toEqual(before);
    expect(stripe.calls.slice(calls).every((c) => c.method === 'GET')).toBe(true);
  });

  it('logs a refund the ledger has and Stripe does not', async () => {
    const read = logged();
    const { h, key, charge } = await paid();
    await admin(h, '/refund', refundBody(key, 5));
    charge.amount_refunded = 0;
    await deliver(h, { kind: 'reconcile', account: h.platform.account });
    expect(read()).toEqual([expect.objectContaining({ problem: 'refund_total', ledger_usd: 5, stripe_usd: 0 })]);
  });

  it('logs a dispute the ledger never heard of', async () => {
    const read = logged();
    const { h, charge } = await paid();
    charge.disputed = true;
    await deliver(h, { kind: 'reconcile', account: h.platform.account });
    expect(read()).toEqual([expect.objectContaining({ problem: 'dispute_missing' })]);
  });

  it('logs a charge with no top-up here, and a top-up with no charge at Stripe', async () => {
    const read = logged();
    const { h, stripe, key, charge } = await paid();
    stripe.charges.delete(charge.id);
    stripe.charges.set('ch_other', { ...charge, id: 'ch_other', metadata: { workspace: h.platform.account, top_up: 'topup-77' } });
    await deliver(h, { kind: 'reconcile', account: h.platform.account });
    const problems = read().map((e) => [e.problem, e.top_up]).sort();
    expect(problems).toEqual([['charge_without_top_up', 'topup-77'], ['top_up_without_charge', key]]);
  });

  it('logs a charged amount that differs', async () => {
    const read = logged();
    const { h, charge } = await paid();
    charge.amount_captured = 1500;
    await deliver(h, { kind: 'reconcile', account: h.platform.account });
    expect(read()).toEqual([expect.objectContaining({ problem: 'amount', ledger_usd: 20, stripe_usd: 15 })]);
  });

  it('skips an account with no Stripe customer without calling Stripe', async () => {
    const { h, stripe } = await paid();
    const calls = stripe.calls.length;
    await deliver(h, { kind: 'reconcile', account: 'nobody_here' });
    expect(stripe.calls).toHaveLength(calls);
  });

  it('never logs card data', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { h, stripe, charge } = await paid();
    stripe.dashboardRefund(charge, 700);
    await deliver(h, { kind: 'reconcile', account: h.platform.account });
    const text = JSON.stringify(spy.mock.calls);
    expect(text).not.toContain('pm_card_1');
    expect(text).not.toContain('4242');
  });
});
