// The operators' Billing section: its paths, what a refund would do before it is sent (spent
// credit, a negative balance, what the server would refuse), the confirmations that name the
// amount and the customer, and how the section reads when empty, full and limited.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AdminBilling, AdminTopUp } from '../../../../shared/admin-billing';
import { BillingSummary } from './AdminBilling';
import { ReasonDialogBody } from './AdminBillingDialogs';
import { TopUpsTable } from './AdminBillingTables';
import { RefundForm } from './AdminRefundDialog';
import {
  actionConfirm,
  billingPath,
  defaultRefund,
  ledgerPath,
  money,
  moneyDown,
  refundConfirm,
  refundPlan,
  refundResult,
  usagePath,
} from './adminBillingModel';

const topUp = (extra: Partial<AdminTopUp> = {}): AdminTopUp => ({
  id: 'topup-1',
  amount_usd: 20,
  status: 'succeeded',
  error: null,
  created_at: 1_700_000_000_000,
  payment_intent: 'pi_123',
  refunded_usd: 0,
  frozen_usd: 0,
  unspent_usd: 14.999,
  refundable_usd: 20,
  disputed: false,
  ...extra,
});
const billing = (extra: Partial<AdminBilling> = {}): AdminBilling => ({
  workspace: 'alice',
  balance: { granted_usd: 120, used_usd: 95, balance_usd: 25 },
  customer: 'cus_123',
  stripe_url: 'https://dashboard.stripe.com/test/customers/cus_123',
  card: { brand: 'visa', last4: '4242', added_at: 1 },
  auto_top_up: true,
  top_up_failed: null,
  paused: null,
  top_ups: [topUp()],
  refunds: [],
  disputes: [],
  refund: { configured: true, max_usd: 50, daily_usd: 100, used_today_usd: 10 },
  ...extra,
});

describe('paths', () => {
  it('names the account and the page', () => {
    expect(billingPath('a@b.co')).toBe('/admin/accounts/a%40b.co/billing');
    expect(ledgerPath('alice')).toBe('/admin/accounts/alice/billing/ledger');
    expect(ledgerPath('alice', 9)).toBe('/admin/accounts/alice/billing/ledger?before=9');
    expect(usagePath('alice', 9)).toBe('/admin/accounts/alice/billing/usage?before=9');
  });
});

describe('what a refund would do', () => {
  it('offers the unspent credit, in whole cents rounded down', () => {
    expect(defaultRefund(topUp())).toBe('14.99');
    expect(defaultRefund(topUp({ unspent_usd: 0, refundable_usd: 12 }))).toBe('12.00');
  });

  it('takes unspent credit without any flag', () => {
    expect(refundPlan(topUp(), 25, '10')).toEqual({
      amount: 10,
      problem: null,
      spent: 0,
      after: 15,
      negative: false,
    });
  });

  it('rounds what is left down, as the server counts it, never up to a cent that is not there', () => {
    // $14.999 unspent: $15.00 is over it, and the server would refuse it as spent credit.
    expect(refundPlan(topUp(), 25, '15')).toMatchObject({ spent: 0.01 });
    expect(refundPlan(topUp(), 25, '14.99')).toMatchObject({ spent: 0 });
    // A balance of $14.999: $15.00 leaves it negative.
    expect(refundPlan(topUp({ unspent_usd: 20 }), 14.999, '15')).toMatchObject({
      negative: true,
      after: -0.01,
    });
    expect(moneyDown(14.999)).toBe('$14.99');
  });

  it('says how much is spent credit', () => {
    const plan = refundPlan(topUp({ unspent_usd: 5 }), 25, '12');
    expect(plan).toMatchObject({ spent: 7, negative: false, after: 13 });
  });

  it('says when the balance would go negative, and to what', () => {
    expect(refundPlan(topUp({ unspent_usd: 5 }), 5, '12')).toMatchObject({
      after: -7,
      negative: true,
    });
    expect(money(-7)).toBe('-$7.00');
  });

  it.each([
    ['', 'Enter an amount.'],
    ['0', 'Enter an amount.'],
    ['-1', 'Enter an amount.'],
    ['abc', 'Enter an amount.'],
    ['1.005', 'Use whole cents.'],
    ['20.01', 'At most $20.00 can be refunded.'],
    ['16', 'Over the limit of $15.00 per refund.'],
  ])('refuses %j before sending', (text, problem) => {
    expect(refundPlan(topUp(), 25, text, 15).problem).toBe(problem);
  });
});

describe('confirmations', () => {
  it('name the amount and the customer', () => {
    const text = refundConfirm('alice', topUp(), 12.5);
    expect(text).toContain('$12.50');
    expect(text).toContain('alice');
    expect(actionConfirm({ kind: 'credit' }, 'alice', '5')).toContain('$5.00');
    expect(actionConfirm({ kind: 'credit' }, 'alice', '5')).toContain('alice');
    for (const action of [
      { kind: 'auto-top-up-off' },
      { kind: 'remove-card' },
      { kind: 'pause', paused: true },
      { kind: 'pause', paused: false },
    ] as const)
      expect(actionConfirm(action, 'alice', '')).toContain('alice');
  });

  it('say what became of a refund', () => {
    expect(refundResult({ status: 'succeeded', amount_usd: 5 })).toBe('Refunded $5.00.');
    expect(refundResult({ status: 'open', amount_usd: 5 })).toContain('Stripe has not confirmed');
  });
});

describe('the section', () => {
  it('shows the card as brand and last four, and links the Stripe customer', () => {
    const html = renderToStaticMarkup(createElement(BillingSummary, { billing: billing() }));
    expect(html).toContain('visa');
    expect(html).toContain('4242');
    expect(html).toContain('href="https://dashboard.stripe.com/test/customers/cus_123"');
    expect(html).toContain('$25.00');
  });

  it('reads plainly for an account with no billing', () => {
    const html = renderToStaticMarkup(
      createElement(BillingSummary, {
        billing: billing({ customer: null, stripe_url: null, card: null, top_ups: [] }),
      }),
    );
    expect(html).toContain('No card');
    expect(html).toContain('No Stripe customer');
  });

  it('warns of a pause, a dispute, and missing refund set-up', () => {
    const html = renderToStaticMarkup(
      createElement(BillingSummary, {
        billing: billing({
          paused: { at: 1, reason: 'Fraud review', by: 'boss' },
          disputes: [
            {
              id: 'dp_1',
              top_up: 'topup-1',
              charge: 'ch_1',
              amount_usd: 20,
              frozen_usd: 20,
              status: 'open',
              reason: 'fraudulent',
              opened_at: 1,
              closed_at: null,
            },
          ],
          refund: { configured: false, max_usd: null, daily_usd: null, used_today_usd: 0 },
        }),
      }),
    );
    expect(html).toContain('Fraud review');
    expect(html).toContain('1 open dispute');
    expect(html).toContain('Refunds are not set up here');
  });

  it('shows no refund button a server would refuse', () => {
    const table = (t: AdminTopUp, b = billing()) =>
      renderToStaticMarkup(
        createElement(TopUpsTable, { billing: { ...b, top_ups: [t] }, onRefund: () => {} }),
      );
    expect(table(topUp())).toContain('Refund topup-1');
    expect(table(topUp())).not.toContain('disabled');
    expect(table(topUp({ disputed: true }))).toContain('disabled');
    expect(table(topUp({ refundable_usd: 0 }))).toContain('disabled');
    expect(table(topUp({ status: 'failed', payment_intent: null }))).toContain('disabled');
    expect(
      table(
        topUp(),
        billing({ refund: { configured: false, max_usd: 5, daily_usd: 5, used_today_usd: 0 } }),
      ),
    ).toContain('disabled');
    expect(
      table(
        topUp(),
        billing({ refund: { configured: true, max_usd: null, daily_usd: 5, used_today_usd: 0 } }),
      ),
    ).toContain('disabled');
    expect(table(topUp())).toContain('pi_123');
  });

  it('says there are no top-ups yet', () => {
    expect(
      renderToStaticMarkup(
        createElement(TopUpsTable, { billing: billing({ top_ups: [] }), onRefund: () => {} }),
      ),
    ).toContain('No top-ups');
  });
});

describe('the forms', () => {
  const form = (extra: Partial<Parameters<typeof RefundForm>[0]>) =>
    renderToStaticMarkup(
      createElement(RefundForm, {
        topUp: topUp({ unspent_usd: 5 }),
        billing: billing({ balance: { granted_usd: 0, used_usd: 0, balance_usd: 5 } }),
        amount: '5',
        reason: 'Asked',
        spentOk: false,
        negativeOk: false,
        onChange: () => {},
        onNext: () => {},
        onCancel: () => {},
        ...extra,
      }),
    );

  it('asks for nothing more within the unspent credit', () => {
    const html = form({});
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('disabled=""');
  });

  it('needs its own confirmation for spent credit', () => {
    const html = form({ amount: '4.99', topUp: topUp({ unspent_usd: 1 }) });
    expect(html).toContain('$3.99 of this was already spent');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled=""');
    expect(form({ amount: '4.99', topUp: topUp({ unspent_usd: 1 }), spentOk: true })).not.toContain(
      'disabled=""',
    );
  });

  it('shows the negative balance and refuses by default', () => {
    const html = form({ amount: '8', spentOk: true });
    expect(html).toContain('-$3.00');
    expect(html).toContain('disabled=""');
    expect(form({ amount: '8', spentOk: true, negativeOk: true })).not.toContain('disabled=""');
  });

  it('needs a reason', () => {
    expect(form({ reason: '  ' })).toContain('disabled=""');
    const body = renderToStaticMarkup(
      createElement(ReasonDialogBody, {
        action: { kind: 'remove-card' },
        reason: '',
        amount: '',
        onReason: () => {},
        onAmount: () => {},
      }),
    );
    expect(body).toContain('textarea');
  });
});
