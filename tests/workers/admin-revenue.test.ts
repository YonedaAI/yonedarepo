// The operators' revenue view, read from the D1 rollup the ledgers push to (real D1, rows shaped
// by the real migration; tests/managed/admin-rollup.test.ts writes them). Who may read it, the
// switch, the arithmetic, what stays apart, and that what was not recorded says so.
import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
import { api, bindings, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const operators = (extra: Partial<Env> = {}) =>
  ({ ...scoped, ADMIN_ACCOUNTS: 'boss', ADMIN_BILLING: 'on', MANAGED_ADMIN_TOKEN: 'managed-secret', ...extra }) as unknown as Env;
const M = 1_000_000;
const COLUMNS = ['top_ups', 'refunds', 'disputes_lost', 'free_granted', 'model_charged', 'model_cost', 'container_charged', 'unpriced_charged'] as const;
type Day = Partial<Record<(typeof COLUMNS)[number], number>>;

async function day(account: string, date: string, values: Day) {
  await bindings.INDEX.prepare(
    `INSERT INTO billing_daily (account, day, version, ${COLUMNS.join(',')}) VALUES (?,?,1,${COLUMNS.map(() => '?').join(',')})`,
  )
    .bind(account, date, ...COLUMNS.map((c) => values[c] ?? 0))
    .run();
}
async function position(account: string, values: { paid?: string | null; sold?: number; free?: number; frozen?: number; open?: number }) {
  await bindings.INDEX.prepare(
    `INSERT INTO billing_accounts (account, version, updated_at, first_paid_day, sold_outstanding, free_outstanding, frozen, refunds_open) VALUES (?,1,?,?,?,?,?,?)`,
  )
    .bind(account, 1_700_000_000_000, values.paid ?? null, values.sold ?? 0, values.free ?? 0, values.frozen ?? 0, values.open ?? 0)
    .run();
}
const revenue = async (query: string, cookie: string, target = operators()) =>
  api(`/admin/revenue${query}`, { cookie }, {}, target);

beforeEach(async () => {
  await bindings.INDEX.exec('DELETE FROM billing_daily');
  await bindings.INDEX.exec('DELETE FROM billing_accounts');
});

it('answers operators only, before touching anything', async () => {
  const user = await signup('plain_user');
  const boss = await signup('boss');
  const token = (await api('/tokens', { cookie: boss }, { body: { name: 'cli', scopes: ['repo:read', 'repo:write'] } })).body.token as string;
  for (const auth of [{ cookie: user }, { token }, {}]) {
    expect((await api('/admin/revenue', auth, {}, operators())).status).toBeGreaterThanOrEqual(401);
    expect((await api('/admin/revenue/rebuild', auth, { body: {} }, operators())).status).toBeGreaterThanOrEqual(401);
  }
});

it('does not exist until ADMIN_BILLING is on, and the overview says which', async () => {
  const boss = await signup('boss');
  const off = operators({ ADMIN_BILLING: undefined });
  expect((await revenue('', boss, off)).status).toBe(404);
  expect((await api('/admin/revenue/rebuild', { cookie: boss }, { body: {} }, off)).status).toBe(404);
  expect((await api('/admin/overview', { cookie: boss }, {}, off)).body.billing).toBe(false);
  expect((await api('/admin/overview', { cookie: boss }, {}, operators())).body.billing).toBe(true);
});

it('adds up gross, refunds, disputes lost and net, by day and by month, within the range', async () => {
  const boss = await signup('boss');
  await day('acct_a', '2026-09-30', { top_ups: 20 * M });
  await day('acct_a', '2026-10-01', { top_ups: 20 * M, refunds: 5 * M });
  await day('acct_b', '2026-10-01', { top_ups: 40 * M, disputes_lost: 20 * M });
  await day('acct_b', '2026-10-15', { top_ups: 20 * M });
  await day('acct_b', '2026-11-01', { top_ups: 999 * M });
  const daily = (await revenue('?from=2026-09-30&to=2026-10-15&by=day', boss)).body;
  expect(daily).toMatchObject({ from: '2026-09-30', to: '2026-10-15', by: 'day', source: 'ledger' });
  expect(daily.totals).toEqual({ gross_top_ups_usd: 100, refunds_usd: 5, disputes_lost_usd: 20, net_revenue_usd: 75 });
  expect(daily.periods.map((p: any) => [p.period, p.gross_top_ups_usd, p.refunds_usd, p.disputes_lost_usd, p.net_revenue_usd])).toEqual([
    ['2026-10-15', 20, 0, 0, 20],
    ['2026-10-01', 60, 5, 20, 35],
    ['2026-09-30', 20, 0, 0, 20],
  ]);
  const monthly = (await revenue('?from=2026-09-30&to=2026-10-15&by=month', boss)).body;
  expect(monthly.periods.map((p: any) => [p.period, p.net_revenue_usd])).toEqual([['2026-10', 55], ['2026-09', 20]]);
  expect(monthly.totals).toEqual(daily.totals);
});

it('keeps sold credit, a liability, out of revenue and apart from free credit', async () => {
  const boss = await signup('boss');
  await day('acct_a', '2026-10-01', { top_ups: 20 * M });
  await position('acct_a', { paid: '2026-10-01', sold: 15 * M, free: 4 * M, frozen: 2 * M, open: 3 * M });
  await position('acct_b', { sold: 0, free: 5 * M });
  const { body } = await revenue('?from=2026-10-01&to=2026-10-31', boss);
  expect(body.outstanding).toMatchObject({ sold_usd: 15, free_usd: 9, frozen_usd: 2, refunds_open_usd: 3, accounts: 2 });
  expect(body.totals.net_revenue_usd).toBe(20);
  // Now, whatever the range: a position is not a period.
  const later = await revenue('?from=2020-01-01&to=2020-01-31', boss);
  expect(later.body.outstanding.sold_usd).toBe(15);
});

it('gives margin only where a cost was recorded, and says not recorded for the rest', async () => {
  const boss = await signup('boss');
  await day('acct_a', '2026-10-01', { model_charged: 13 * M, model_cost: 10 * M, container_charged: 2 * M, unpriced_charged: 1 * M, free_granted: 100 * M });
  const { body } = await revenue('?from=2026-10-01&to=2026-10-31', boss);
  expect(body.usage).toEqual({
    consumed_usd: 16,
    free_granted_usd: 100,
    model: { charged_usd: 13, cost_usd: 10, margin_usd: 3, markup: 1.3 },
    container: { charged_usd: 2, cost_usd: null, margin_usd: null },
    unpriced: { charged_usd: 1, cost_usd: null, margin_usd: null },
  });
  expect(body.stripe_fees_usd).toBeNull();
});

it('has no markup to show with no recorded cost, rather than dividing by zero', async () => {
  const boss = await signup('boss');
  await day('acct_a', '2026-10-01', { container_charged: 2 * M });
  const { body } = await revenue('?from=2026-10-01&to=2026-10-31', boss);
  expect(body.usage.model).toEqual({ charged_usd: 0, cost_usd: 0, margin_usd: 0, markup: null });
});

it('never calls anything profit', async () => {
  const boss = await signup('boss');
  await day('acct_a', '2026-10-01', { top_ups: 20 * M });
  expect(JSON.stringify((await revenue('?from=2026-10-01&to=2026-10-31', boss)).body)).not.toMatch(/profit/i);
});

it('ranks top paying accounts by net, and counts paying and active paying accounts', async () => {
  const boss = await signup('boss');
  await day('big_payer', '2026-10-02', { top_ups: 100 * M, refunds: 10 * M });
  await day('refunded_payer', '2026-10-02', { top_ups: 200 * M, refunds: 195 * M });
  await day('small_payer', '2026-10-02', { top_ups: 20 * M, model_charged: 1 * M, model_cost: M / 2 });
  // Paid before the range and used credit in it: active, not paying in the range.
  await day('earlier_payer', '2026-09-01', { top_ups: 20 * M });
  await day('earlier_payer', '2026-10-03', { container_charged: M });
  // Only ever used free credit: neither.
  await day('free_user', '2026-10-03', { model_charged: M, model_cost: M / 2, free_granted: 5 * M });
  await position('big_payer', { paid: '2026-10-02' });
  await position('refunded_payer', { paid: '2026-10-02' });
  await position('small_payer', { paid: '2026-10-02' });
  await position('earlier_payer', { paid: '2026-09-01' });
  await position('free_user', {});
  const { body } = await revenue('?from=2026-10-01&to=2026-10-31', boss);
  expect(body.accounts.top.map((a: any) => [a.account, a.net_usd, a.gross_usd])).toEqual([
    ['big_payer', 90, 100],
    ['small_payer', 20, 20],
    ['refunded_payer', 5, 200],
  ]);
  expect(body.accounts.paying).toBe(3);
  expect(body.accounts.active_paying).toBe(2);
});

it('caps the top accounts at ten', async () => {
  const boss = await signup('boss');
  for (let n = 0; n < 12; n++) await day(`payer_${n}`, '2026-10-02', { top_ups: (n + 1) * M });
  const { body } = await revenue('?from=2026-10-01&to=2026-10-31', boss);
  expect(body.accounts.top).toHaveLength(10);
  expect(body.accounts.top[0].account).toBe('payer_11');
  expect(body.accounts.paying).toBe(12);
});

it('defaults to the last 30 UTC days by day, and is empty, not failing, with nothing recorded', async () => {
  const boss = await signup('boss');
  vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 9, 31, 12) });
  try {
    const { status, body } = await revenue('', boss);
    expect(status).toBe(200);
    expect(body).toMatchObject({ from: '2026-10-02', to: '2026-10-31', by: 'day', periods: [] });
    expect(body.totals.net_revenue_usd).toBe(0);
    expect(body.outstanding).toMatchObject({ sold_usd: 0, accounts: 0, as_of: null });
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  '?from=2026-13-01&to=2026-10-31',
  '?from=2026-10-01',
  '?from=nonsense&to=2026-10-31',
  '?from=2026-10-31&to=2026-10-01',
  '?from=2026-10-01&to=2026-10-31&by=week',
  '?from=2024-01-01&to=2026-10-31&by=day',
])('refuses %s', async (query) => {
  const boss = await signup('boss');
  expect((await revenue(query, boss)).status).toBe(400);
});

it('takes a long range by month', async () => {
  const boss = await signup('boss');
  expect((await revenue('?from=2024-01-01&to=2026-10-31&by=month', boss)).status).toBe(200);
});

it('reads D1 alone: no ledger is woken to draw the page', async () => {
  const boss = await signup('boss');
  const fetch = vi.fn(async () => Response.json({}));
  const res = await revenue('?from=2026-10-01&to=2026-10-31', boss, operators({ MANAGED: { fetch } as unknown as Fetcher }));
  expect(res.status).toBe(200);
  expect(fetch).not.toHaveBeenCalled();
});

it('rebuilds from the ledgers a page of accounts at a time, audited, orgs that own repositories included', async () => {
  const boss = await signup('boss');
  await signup('zed_user');
  await bindings.INDEX.prepare("INSERT INTO platform_repos (id, workspace, name, created_at) VALUES ('r00000000000000000001', 'some_org', 'x', 1)").run();
  const calls: any[] = [];
  const MANAGED = {
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
      return Response.json({ queued: 1 }, { status: 202 });
    },
  } as unknown as Fetcher;
  const res = await api('/admin/revenue/rebuild', { cookie: boss }, { body: {} }, operators({ MANAGED }));
  expect(res.status).toBe(200);
  expect(calls[0]).toMatchObject({ url: 'https://managed/admin/billing/rollup', auth: 'Bearer managed-secret' });
  expect(calls[0].body.accounts).toEqual(expect.arrayContaining(['some_org']));
  expect(res.body).toMatchObject({ queued: calls[0].body.accounts.length, next: null });
  const audit = await bindings.INDEX.prepare("SELECT actor, action FROM admin_audit WHERE action = 'billing.rollup_rebuild'").all<any>();
  expect(audit.results).toEqual([{ actor: 'boss', action: 'billing.rollup_rebuild' }]);
});
