// The revenue view: its range and paths, the rebuild's paging, and the words that keep the numbers
// honest (ledger amounts labelled, a liability kept apart, not recorded where nothing was, and
// never "profit").
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AdminRevenue } from '../../../../shared/admin-billing';
import { RevenueReport } from './AdminRevenueReport';
import { defaultRange, rangeProblem, rebuildAll, recorded, revenuePath } from './adminRevenueModel';

const money = {
  gross_top_ups_usd: 100,
  refunds_usd: 5,
  disputes_lost_usd: 20,
  net_revenue_usd: 75,
};
const report = (extra: Partial<AdminRevenue> = {}): AdminRevenue => ({
  from: '2026-10-01',
  to: '2026-10-31',
  by: 'day',
  source: 'ledger',
  totals: money,
  periods: [{ period: '2026-10-02', ...money, consumed_usd: 16 }],
  outstanding: {
    as_of: 1_700_000_000_000,
    accounts: 3,
    sold_usd: 15,
    free_usd: 9,
    frozen_usd: 2,
    refunds_open_usd: 3,
  },
  usage: {
    consumed_usd: 16,
    free_granted_usd: 100,
    model: { charged_usd: 13, cost_usd: 10, margin_usd: 3, markup: 1.3 },
    container: { charged_usd: 2, cost_usd: null, margin_usd: null },
    unpriced: { charged_usd: 1, cost_usd: null, margin_usd: null },
  },
  stripe_fees_usd: null,
  accounts: {
    paying: 3,
    active_paying: 2,
    top: [{ account: 'big_payer', gross_usd: 100, net_usd: 90 }],
  },
  ...extra,
});
const html = (r = report()) =>
  renderToStaticMarkup(createElement(RevenueReport, { report: r, navigate: () => {} }));
const section = (text: string, heading: string, next: string) =>
  text.slice(text.indexOf(heading), text.indexOf(next));

describe('the range', () => {
  it('defaults to the last 30 UTC days', () => {
    expect(defaultRange(Date.UTC(2026, 9, 31, 23))).toEqual({
      from: '2026-10-02',
      to: '2026-10-31',
      by: 'day',
    });
  });

  it('asks for what it read', () => {
    expect(revenuePath({ from: '2026-10-01', to: '2026-10-31', by: 'month' })).toBe(
      '/admin/revenue?from=2026-10-01&to=2026-10-31&by=month',
    );
  });

  it.each([
    [{ from: '', to: '2026-10-31', by: 'day' }, 'Pick both dates.'],
    [{ from: '2026-11-01', to: '2026-10-31', by: 'day' }, 'From is after to.'],
    [
      { from: '2024-01-01', to: '2026-10-31', by: 'day' },
      'By day covers up to 366 days: use by month.',
    ],
    [{ from: '2024-01-01', to: '2026-10-31', by: 'month' }, null],
    [{ from: '2026-10-01', to: '2026-10-31', by: 'day' }, null],
  ] as const)('checks %j', (range, problem) => {
    expect(rangeProblem(range)).toBe(problem);
  });
});

describe('what was not recorded', () => {
  it('reads as that, and zero reads as zero', () => {
    expect(recorded(null)).toBe('not recorded');
    expect(recorded(0)).toBe('$0.00');
    expect(recorded(3)).toBe('$3.00');
  });

  it('marks container cost, unknown calls, total cost and Stripe fees, and gives model margin', () => {
    const text = html();
    const usage = section(text, 'Usage', 'Accounts');
    expect(usage.match(/not recorded/g)?.length).toBeGreaterThanOrEqual(7);
    expect(usage).toContain('$3.00');
    expect(usage).toContain('list rates');
    expect(text).toContain('Stripe fees');
  });
});

describe('the words', () => {
  it('labels the numbers as the ledger’s, and names what checks them', () => {
    const text = html();
    expect(text).toContain('ledger');
    expect(text).toContain('reconcile');
  });

  it('never says profit', () => {
    expect(html()).not.toMatch(/profit/i);
  });

  it('keeps sold credit apart, as a liability, and says free credit is not sold', () => {
    const outstanding = section(html(), 'Credit outstanding', 'Usage');
    expect(outstanding).toContain('liability');
    expect(outstanding).toContain('$15.00');
    expect(outstanding).toContain('not revenue');
    expect(section(html(), 'Credit outstanding', 'Usage')).toContain('$9.00');
  });

  it('says net revenue comes before fees and still holds unused credit', () => {
    const text = html();
    expect(text).toContain('$75.00');
    expect(text).toMatch(/before Stripe fees/i);
  });

  it('says usage includes credit that was given away', () => {
    expect(section(html(), 'Usage', 'Accounts')).toContain('$100.00');
  });
});

describe('the accounts', () => {
  it('counts payers and links the top ones to their account page', () => {
    const text = html();
    expect(text).toContain('/admin/users/big_payer');
    expect(text).toContain('$90.00');
  });
});

describe('with nothing recorded', () => {
  it('says so and points at the rebuild, rather than showing an empty table', () => {
    const empty = report({
      periods: [],
      accounts: { paying: 0, active_paying: 0, top: [] },
      outstanding: {
        as_of: null,
        accounts: 0,
        sold_usd: 0,
        free_usd: 0,
        frozen_usd: 0,
        refunds_open_usd: 0,
      },
    });
    const text = html(empty);
    expect(text).toContain('Nothing recorded in this range');
    expect(text).toContain('No paying accounts in this range');
  });
});

describe('rebuilding', () => {
  it('walks every page, and reports how many accounts it asked', async () => {
    const seen: (string | undefined)[] = [];
    const pages = [
      { queued: 100, next: 'mm' },
      { queued: 7, next: null },
    ];
    const total = await rebuildAll(async (after) => {
      seen.push(after);
      return pages[seen.length - 1];
    });
    expect(seen).toEqual([undefined, 'mm']);
    expect(total).toBe(107);
  });
});
