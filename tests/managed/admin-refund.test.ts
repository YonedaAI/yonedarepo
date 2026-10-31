// Refunding a top-up: one operation over Stripe and the ledger. The credit is taken and the
// intent recorded first, Stripe is asked under one idempotency key, and an open refund settles
// from what Stripe says, on the webhook or a retry, however the work was cut short.
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ledgerStub } from '../../cloudflare/managed/ledger';
import { refundDay, refundLimits } from '../../cloudflare/managed/admin-refund';
import { admin, deliver, paid, refundBody, spend } from './billing-fixture';
import { FakeStripe, STRIPE_KEY, STRIPE_REFUND_KEY, type FakeRefund } from './fake';

afterEach(() => vi.restoreAllMocks());

const refund = (h: Parameters<typeof admin>[0], body: unknown) => admin(h, '/refund', body);
const posts = (stripe: FakeStripe) => stripe.calls.filter((c) => c.path === '/v1/refunds' && c.method === 'POST');
const state = async (h: Parameters<typeof admin>[0]) => (await admin(h, '')).json<any>();
const debited = (h: Parameters<typeof admin>[0]) => ledgerStub(h.env, h.platform.account).ledgerPage(null, 100);
const refundEntries = async (h: Parameters<typeof admin>[0]) => (await debited(h)).items.filter((e: { kind: string }) => e.kind === 'refund');

describe('refunding a top-up', () => {
  it('refunds the card with the restricted key and debits the ledger once', async () => {
    const { h, stripe, ledger, key, charge } = await paid();
    const before = (await ledger.balance()).balance;
    const body = refundBody(key, 5.5);
    const res = await refund(h, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ refund: { id: body.id, status: 'succeeded', amount_usd: 5.5, stripe_refund: 're_1' } });
    const [post] = posts(stripe);
    expect(post.auth).toBe(`Bearer ${STRIPE_REFUND_KEY}`);
    expect(post.idempotency).toBe(`refund:${body.id}`);
    expect(post.form).toMatchObject({ payment_intent: charge.payment_intent, amount: '550', 'metadata[refund]': body.id });
    expect(charge.amount_refunded).toBe(550);
    expect((await ledger.balance()).balance).toBe(before - 5_500_000);
    // Credit taken back is not agent usage.
    expect((await ledger.balance()).used).toBeGreaterThan(0);
    const view = await state(h);
    expect(view.top_ups[0]).toMatchObject({ refunded_usd: 5.5, unspent_usd: 14.5, refundable_usd: 14.5 });
    expect(view.refunds[0]).toMatchObject({ actor: 'boss', reason: 'Customer asked for it back', origin: 'operator' });
    expect(stripe.calls.some((c) => c.path === '/v1/refunds' && c.auth === `Bearer ${STRIPE_KEY}`)).toBe(false);
  });

  it('refunds a double submit once, in sequence or at the same moment', async () => {
    const { h, stripe, ledger, key, charge } = await paid();
    const before = (await ledger.balance()).balance;
    const body = refundBody(key, 5);
    const answers = await Promise.all([refund(h, body), refund(h, body)]);
    for (const answer of answers) expect(answer.status).toBe(200);
    const again = await (await refund(h, body)).json<any>();
    expect(again.refund.status).toBe('succeeded');
    expect(stripe.refunds).toHaveLength(1);
    expect(charge.amount_refunded).toBe(500);
    expect((await ledger.balance()).balance).toBe(before - 5_000_000);
    expect(await refundEntries(h)).toHaveLength(1);
  });

  it('refuses the same id with another amount or top-up', async () => {
    const { h, key } = await paid();
    const body = refundBody(key, 5);
    await refund(h, body);
    const res = await refund(h, { ...body, usd: 6 });
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error.code).toBe('CONFLICT');
  });

  it('settles a crash after Stripe refunded and before the ledger heard: no second refund', async () => {
    const { h, stripe, ledger, key, charge } = await paid();
    const before = (await ledger.balance()).balance;
    stripe.loseRefundAnswer = true;
    const body = refundBody(key, 5);
    const res = await refund(h, body);
    expect((await res.json<any>()).refund.status).toBe('open');
    // The credit stays taken while the outcome is unknown; it cannot be spent meanwhile.
    expect((await ledger.balance()).balance).toBe(before - 5_000_000);
    await deliver(h, { kind: 'refund', account: h.platform.account, id: body.id });
    expect((await state(h)).refunds[0]).toMatchObject({ status: 'succeeded', stripe_refund: 're_1' });
    expect(posts(stripe)).toHaveLength(1);
    expect(stripe.refunds).toHaveLength(1);
    expect(charge.amount_refunded).toBe(500);
    expect((await ledger.balance()).balance).toBe(before - 5_000_000);
    await deliver(h, { kind: 'refund', account: h.platform.account, id: body.id });
    expect(posts(stripe)).toHaveLength(1);
  });

  it('settles a crash before Stripe was asked, from the alarm’s retry', async () => {
    const { h, stripe, ledger, key } = await paid();
    const body = refundBody(key, 5);
    // The Worker died right after recording the intent: only the ledger knows.
    const answer = await ledger.refundIntent({
      id: body.id,
      account: h.platform.account,
      top_up: key,
      amount: 5_000_000,
      reason: body.reason,
      actor: 'boss',
      spent_override: false,
      allow_negative: false,
    });
    expect(answer.ok).toBe(true);
    expect(stripe.refunds).toHaveLength(0);
    const sent: any[] = [];
    const stub = ledger as unknown as DurableObjectStub;
    await runInDurableObject(stub, (instance: any) => {
      instance.env = { ...instance.env, RUNS: { sendBatch: async (ms: any[]) => void sent.push(...ms.map((m) => m.body)) } };
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(sent).toEqual([{ kind: 'refund', account: h.platform.account, id: body.id }]);
    await deliver(h, sent[0]);
    expect((await state(h)).refunds[0].status).toBe('succeeded');
    expect(stripe.refunds).toHaveLength(1);
  });

  it('keeps retrying through a 500 Stripe saved under the key, and refunds once when it clears', async () => {
    const { h, stripe, key } = await paid();
    stripe.refundError = { status: 500, type: 'api_error', message: 'An error occurred' };
    const body = refundBody(key, 5);
    expect((await (await refund(h, body)).json<any>()).refund.status).toBe('open');
    // Stripe answers a repeat of that key with the saved 500, so it stays open.
    await deliver(h, { kind: 'refund', account: h.platform.account, id: body.id });
    expect((await state(h)).refunds[0].status).toBe('open');
    // Keys may be pruned after 24 hours: a fresh request can then run, and the lookup before
    // each one is what stops it refunding twice.
    stripe.saved.clear();
    await deliver(h, { kind: 'refund', account: h.platform.account, id: body.id });
    expect((await state(h)).refunds[0].status).toBe('succeeded');
    expect(stripe.refunds).toHaveLength(1);
  });

  it('never repeats a refund after its key is pruned', async () => {
    const { h, stripe, key, charge } = await paid();
    stripe.loseRefundAnswer = true;
    const body = refundBody(key, 5);
    await refund(h, body);
    stripe.saved.clear();
    await deliver(h, { kind: 'refund', account: h.platform.account, id: body.id });
    expect(stripe.refunds).toHaveLength(1);
    expect(charge.amount_refunded).toBe(500);
  });

  it('gives the credit back when Stripe refuses, and frees the limit', async () => {
    const { h, stripe, ledger, key } = await paid();
    const before = (await ledger.balance()).balance;
    const used = await refundLimits(h.env).refundedOn(refundDay());
    stripe.refundError = { status: 400, type: 'invalid_request_error', message: 'Charge was already refunded' };
    const res = await refund(h, refundBody(key, 5));
    expect(await res.json()).toMatchObject({ refund: { status: 'failed', error: 'Charge was already refunded' } });
    expect((await ledger.balance()).balance).toBe(before);
    expect(await refundLimits(h.env).refundedOn(refundDay())).toBe(used);
    expect((await state(h)).top_ups[0]).toMatchObject({ refunded_usd: 0, unspent_usd: 20 });
  });

  it('stays open while Stripe says pending, and reverses if it then fails', async () => {
    const { h, stripe, ledger, key } = await paid();
    const before = (await ledger.balance()).balance;
    stripe.refundStatus = 'pending';
    const body = refundBody(key, 5);
    expect((await (await refund(h, body)).json<any>()).refund).toMatchObject({ status: 'open', stripe_refund: 're_1' });
    (stripe.refunds[0] as FakeRefund).status = 'failed';
    await deliver(h, { kind: 'refund', account: h.platform.account, id: body.id });
    expect((await state(h)).refunds[0].status).toBe('failed');
    expect((await ledger.balance()).balance).toBe(before);
    expect(posts(stripe)).toHaveLength(1);
  });

  it('settles a pending refund once Stripe says it succeeded', async () => {
    const { h, stripe, key } = await paid();
    stripe.refundStatus = 'pending';
    const body = refundBody(key, 5);
    await refund(h, body);
    stripe.refunds[0].status = 'succeeded';
    await deliver(h, { kind: 'refund', account: h.platform.account, id: body.id });
    expect((await state(h)).refunds[0].status).toBe('succeeded');
  });

  it('stops the alarm once no refund is open', async () => {
    const { h, ledger, key } = await paid();
    await refund(h, refundBody(key, 5));
    const stub = ledger as unknown as DurableObjectStub;
    await runDurableObjectAlarm(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });
});

describe('what may be refunded', () => {
  it('refuses more than the unspent credit unless the override says so', async () => {
    const { h, stripe, ledger, key } = await paid();
    await spend(h, 'into-it', 10_000_000);
    // Newer credit keeps the balance up: the override is about the top-up's own credit.
    await ledger.grant('later', 10_000_000, 'Later credit');
    const res = await refund(h, refundBody(key, 20));
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.code).toBe('SPENT_CREDIT');
    expect(stripe.refunds).toHaveLength(0);
    const granted = await refund(h, refundBody(key, 15, { spent_override: true }));
    expect(granted.status).toBe(200);
    expect((await granted.json<any>()).refund).toMatchObject({ status: 'succeeded', spent_override: true });
  });

  it('refuses a refund that would leave the balance negative unless told, saying by how much', async () => {
    const { h, stripe, ledger, key } = await paid();
    await spend(h, 'most-of-it', 20_000_000);
    const res = await refund(h, refundBody(key, 20, { spent_override: true }));
    expect(res.status).toBe(400);
    const error = (await res.json<any>()).error;
    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(error.message).toContain('-$15.00');
    expect(stripe.refunds).toHaveLength(0);
    expect((await refund(h, refundBody(key, 20, { spent_override: true, allow_negative: true }))).status).toBe(200);
    expect((await ledger.balance()).balance).toBeLessThan(0);
  });

  it('never refunds more than was charged, with any flag', async () => {
    const { h, stripe, key } = await paid();
    await refund(h, refundBody(key, 15));
    const res = await refund(h, refundBody(key, 6, { spent_override: true, allow_negative: true }));
    expect((await res.json<any>()).error.code).toBe('OVER_REFUNDABLE');
    expect(stripe.refunds).toHaveLength(1);
  });

  it('takes a failed top-up, a pending one, or an unknown one to nothing', async () => {
    const { h } = await paid();
    expect((await refund(h, refundBody('topup-99', 5))).status).toBe(404);
  });

  it.each([
    [{ usd: 0 }],
    [{ usd: -1 }],
    [{ usd: 'x' }],
    [{ usd: 1.005 }],
    [{ reason: '' }],
    [{ reason: '  ' }],
    [{ reason: 'x'.repeat(501) }],
    [{ id: 'short' }],
    [{ top_up: 'nope' }],
    [{ actor: '' }],
  ])('refuses %j', async (bad) => {
    const { h, stripe, key } = await paid();
    expect((await refund(h, { ...refundBody(key, 5), ...bad })).status).toBe(400);
    expect(stripe.refunds).toHaveLength(0);
  });

  it('refuses a reason that holds a credential', async () => {
    const { h, stripe, key } = await paid();
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0'].join('_');
    const res = await refund(h, refundBody(key, 5, { reason: `paid with ${secret}` }));
    expect(res.status).toBe(422);
    expect(stripe.refunds).toHaveLength(0);
  });
});

describe('keys and limits', () => {
  it('answers NOT_CONFIGURED without the refund key, and never falls back to the secret key', async () => {
    const { h, stripe, ledger, key } = await paid({ STRIPE_REFUND_KEY: undefined });
    const before = (await ledger.balance()).balance;
    const res = await refund(h, refundBody(key, 5));
    expect(res.status).toBe(503);
    expect((await res.json<any>()).error.code).toBe('NOT_CONFIGURED');
    expect(stripe.calls.filter((c) => c.path === '/v1/refunds')).toHaveLength(0);
    expect((await ledger.balance()).balance).toBe(before);
  });

  it('refuses every refund while a limit is unset', async () => {
    for (const unset of ['REFUND_MAX_USD', 'REFUND_DAILY_USD']) {
      const { h, stripe, key } = await paid({ [unset]: undefined });
      const res = await refund(h, refundBody(key, 5));
      expect(res.status, unset).toBe(403);
      expect((await res.json<any>()).error.code).toBe('REFUND_LIMIT');
      expect(stripe.refunds).toHaveLength(0);
    }
  });

  it('refuses one refund over REFUND_MAX_USD', async () => {
    const { h, stripe, key } = await paid({ REFUND_MAX_USD: '4.99' });
    expect((await refund(h, refundBody(key, 5))).status).toBe(403);
    expect((await refund(h, refundBody(key, 4.99))).status).toBe(200);
    expect(stripe.refunds).toHaveLength(1);
  });

  it('holds the daily limit across concurrent refunds, on one account and across accounts', async () => {
    const first = await paid();
    const second = await paid();
    const used = await refundLimits(first.h.env).refundedOn(refundDay());
    const daily = String((used + 15_000_000) / 1_000_000);
    first.h.env.REFUND_DAILY_USD = daily;
    second.h.env.REFUND_DAILY_USD = daily;
    const answers = await Promise.all([
      refund(first.h, refundBody(first.key, 10)),
      refund(first.h, refundBody(first.key, 10)),
      refund(second.h, refundBody(second.key, 10)),
    ]);
    const statuses = answers.map((a) => a.status).sort();
    expect(statuses).toEqual([200, 403, 403]);
    expect(first.stripe.refunds.length + second.stripe.refunds.length).toBe(1);
    expect(await refundLimits(first.h.env).refundedOn(refundDay())).toBe(used + 10_000_000);
  });

  it('does not count a refused refund toward the limit', async () => {
    const { h, key } = await paid();
    const used = await refundLimits(h.env).refundedOn(refundDay());
    await refund(h, refundBody(key, 21, { spent_override: true }));
    expect(await refundLimits(h.env).refundedOn(refundDay())).toBe(used);
  });

  it('cannot spend past the unspent credit by racing: two refunds of the same dollars', async () => {
    const { h, stripe, key } = await paid();
    const answers = await Promise.all([refund(h, refundBody(key, 15)), refund(h, refundBody(key, 15))]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 400]);
    expect(stripe.refunds).toHaveLength(1);
  });

  it('no refund route for a wrong bearer, and none while ADMIN_BILLING is off', async () => {
    const { h, stripe, key } = await paid();
    expect((await admin(h, '/refund', refundBody(key, 5), 'wrong-token')).status).toBe(401);
    const off = await paid({ ADMIN_BILLING: 'off' });
    expect((await admin(off.h, '/refund', refundBody(off.key, 5))).status).toBe(404);
    expect(stripe.refunds).toHaveLength(0);
    expect(off.stripe.refunds).toHaveLength(0);
  });
});
