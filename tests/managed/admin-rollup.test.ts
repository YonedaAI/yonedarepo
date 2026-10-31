// The revenue rollup: a ledger's days reach D1 from an outbox written with each entry, as whole
// rows, so a retry changes nothing and the ledgers can rebuild it. What cannot be derived stays
// out: the only recorded cost is a model call's, and only those calls have a margin.
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { refundLimits } from '../../cloudflare/managed/admin-refund';
import { managedFetch } from '../../cloudflare/managed/index';
import { ledgerStub } from '../../cloudflare/managed/ledger';
import { LEDGER_SCHEMA, migrate } from '../../cloudflare/managed/schema';
import { admin, deliver, paid, refundBody, spend } from './billing-fixture';
import type { FakeCharge, FakeStripe, Harness } from './fake';
import { harness } from './fake';
import { days, flush, pending, revenueDb, rollupOn, rollupTables, snapshot, undoRollup } from './rollup-fixture';

beforeAll(rollupTables);
afterEach(() => vi.restoreAllMocks());

const on = (h: Harness) => rollupOn(h);
const meta = (h: Harness, run: string) => ({ repo: h.platform.repo, run, agent: 'code-review', model: 'm' });
const today = () => new Date().toISOString().slice(0, 10);
const dispute = (charge: FakeCharge, type: string, status = 'needs_response') => ({
  id: `evt_${crypto.randomUUID()}`,
  type,
  data: { object: { id: `dp_${charge.id}`, object: 'dispute', charge: charge.id, amount: charge.amount, reason: 'fraudulent', status, metadata: {} } },
});
const send = async (h: Harness, stripe: FakeStripe, event: Record<string, unknown>) =>
  managedFetch(await stripe.webhook(event), h.env);

describe('each entry reaches the rollup', () => {
  it('marks its day in the entry’s own transaction, and the alarm writes it to D1', async () => {
    const { h, ledger } = await paid({}, on);
    await spend(h, 'more', 1_000_000);
    expect(await pending(h)).not.toEqual([]);
    expect(await flush(h)).toBe(true);
    expect(await pending(h)).toEqual([]);
    const [day] = await days(h);
    expect(day).toMatchObject({ day: today(), top_ups: 20_000_000, refunds: 0, disputes_lost: 0 });
    expect(day.free_granted).toBe(100_000_000);
    expect((await snapshot(h)).first_paid_day).toBe(today());
    expect((await ledger.balance()).balance).toBeGreaterThan(0);
  });

  it('coalesces a burst into one write per alarm, losing no entry', async () => {
    const { h } = await paid({}, on);
    await flush(h);
    const batch = vi.spyOn(revenueDb, 'batch');
    for (const n of [1, 2, 3, 4, 5]) await spend(h, `burst-${n}`, 100_000);
    expect(batch).not.toHaveBeenCalled();
    const before = (await days(h))[0].unpriced_charged;
    await flush(h);
    expect((await days(h))[0].unpriced_charged).toBe(before + 500_000);
  });

  it('takes every write path: a future one cannot forget, because a trigger marks the day', async () => {
    const h = harness();
    await on(h);
    const stub = ledgerStub(h.env, h.platform.account);
    await stub.grant('anything', 2_000_000, 'A grant');
    await flush(h);
    expect(await days(h)).toEqual([expect.objectContaining({ free_granted: 2_000_000, top_ups: 0 })]);
  });

  it('never touches D1 from a write: an outage cannot stop a charge, and nothing is lost', async () => {
    const down = { batch: vi.fn(async () => { throw new Error('D1 is down'); }), prepare: revenueDb.prepare.bind(revenueDb) };
    const { h, ledger } = await paid({}, (x) => rollupOn(x, { REVENUE: down }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const key = await spend(h, 'during-outage', 100_000);
    expect(key === null || typeof key === 'string').toBe(true);
    await flush(h);
    expect(down.batch).toHaveBeenCalled();
    expect(await pending(h)).not.toEqual([]);
    expect(await days(h)).toEqual([]);
    expect(JSON.stringify(log.mock.calls)).toContain('billing.rollup');
    await rollupOn(h, { REVENUE: revenueDb });
    await flush(h);
    expect(await pending(h)).toEqual([]);
    expect((await days(h))[0].top_ups).toBe(20_000_000);
    expect((await ledger.balance()).used).toBeGreaterThan(0);
  });

  it('writes nothing with the switch off, and does not wake the ledger for it', async () => {
    const { h, ledger } = await paid({ ADMIN_BILLING: 'off' });
    await spend(h, 'off', 1000);
    expect(await pending(h)).not.toEqual([]);
    expect(await days(h)).toEqual([]);
    expect(await runDurableObjectAlarm(ledger as unknown as DurableObjectStub)).toBe(true); // the hold sweep's
    expect(await days(h)).toEqual([]);
  });

  it('never projects the ledger that counts refunds, which is no account', async () => {
    const { h, key } = await paid({}, on);
    await admin(h, '/refund', refundBody(key, 1));
    const limits = refundLimits(h.env) as unknown as DurableObjectStub;
    await runInDurableObject(limits, (instance: any, state) => {
      instance.env = { ...instance.env, ADMIN_BILLING: 'on' };
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM rollup_dirty').one().n).toBe(0);
    });
    const row = await revenueDb.prepare("SELECT COUNT(*) AS n FROM billing_daily WHERE account LIKE 'billing:%'").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe('what a day holds', () => {
  it('separates what has a recorded cost from what does not, inventing no split', async () => {
    const h = harness();
    await on(h);
    const ledger = ledgerStub(h.env, h.platform.account);
    await ledger.grant('seed', 50_000_000, 'Seed');
    // A model call: the provider's usage priced at list rates, charged with the markup.
    await ledger.hold('call', 2_000_000, meta(h, 'run-1'));
    await ledger.settle('call', { inputTokens: 10, outputTokens: 5, costMicrousd: 1_000_000, chargeMicrousd: 1_300_000 }, true, meta(h, 'run-1'));
    // Container time: a flat rate, no cost recorded.
    await ledger.charge('container:run-1:1', 17_000, meta(h, 'run-1'), 'Container 600 s');
    // A call whose outcome is unknown: its hold charged whole, no usage, no cost.
    await ledger.hold('lost', 900_000, meta(h, 'run-2'));
    await ledger.settle('lost', null, true, meta(h, 'run-2'));
    await flush(h);
    expect((await days(h))[0]).toMatchObject({
      model_charged: 1_300_000,
      model_cost: 1_000_000,
      container_charged: 17_000,
      unpriced_charged: 900_000,
    });
  });

  it('counts refunds when Stripe confirms them, operator’s and dashboard’s alike', async () => {
    const { h, stripe, key, charge } = await paid({}, on);
    await admin(h, '/refund', refundBody(key, 5));
    stripe.dashboardRefund(charge, 200);
    await send(h, stripe, { id: 'evt_r', type: 'charge.refunded', data: { object: { ...charge } } });
    await flush(h);
    expect((await days(h))[0].refunds).toBe(7_000_000);
    expect((await snapshot(h)).refunds_open).toBe(0);
  });

  it('holds an unconfirmed refund out of refunds, and shows it as open', async () => {
    const { h, stripe, key } = await paid({}, on);
    stripe.loseRefundAnswer = true;
    const body = refundBody(key, 5);
    await admin(h, '/refund', body);
    await flush(h);
    expect((await days(h))[0].refunds).toBe(0);
    expect((await snapshot(h)).refunds_open).toBe(5_000_000);
    await deliver(h, { kind: 'refund', account: h.platform.account, id: body.id });
    await flush(h);
    expect((await days(h))[0].refunds).toBe(5_000_000);
    expect((await snapshot(h)).refunds_open).toBe(0);
  });

  it('does not count a refund Stripe refused', async () => {
    const { h, stripe, key } = await paid({}, on);
    stripe.refundError = { status: 400, type: 'invalid_request_error', message: 'No' };
    await admin(h, '/refund', refundBody(key, 5));
    await flush(h);
    expect((await days(h))[0].refunds).toBe(0);
  });

  it('counts the disputed money when a dispute is lost, even past what could be frozen', async () => {
    const { h, stripe, charge } = await paid({}, on);
    await spend(h, 'most', 19_000_000);
    await send(h, stripe, dispute(charge, 'charge.dispute.created'));
    await flush(h);
    expect((await days(h))[0].disputes_lost).toBe(0);
    expect((await snapshot(h)).frozen).toBeGreaterThan(0);
    await send(h, stripe, dispute(charge, 'charge.dispute.closed', 'lost'));
    await flush(h);
    expect((await days(h))[0].disputes_lost).toBe(20_000_000);
    expect((await snapshot(h)).frozen).toBe(0);
  });

  it('counts nothing for a dispute that was won', async () => {
    const { h, stripe, charge } = await paid({}, on);
    await send(h, stripe, dispute(charge, 'charge.dispute.created'));
    await send(h, stripe, dispute(charge, 'charge.dispute.closed', 'won'));
    await flush(h);
    expect((await days(h))[0].disputes_lost).toBe(0);
  });
});

describe('credit outstanding', () => {
  it('keeps sold credit apart from free credit', async () => {
    const { h } = await paid({}, on);
    await flush(h);
    const row = await snapshot(h);
    expect(row.sold_outstanding).toBe(20_000_000);
    expect(row.free_outstanding).toBe(4_999_000);
  });

  it('counts free credit as spent first, and sold credit down as it is used', async () => {
    const { h } = await paid({}, on);
    await spend(h, 'past-free', 10_000_000);
    await flush(h);
    const row = await snapshot(h);
    expect(row.free_outstanding).toBe(0);
    expect(row.sold_outstanding).toBe(14_999_000);
  });

  it('never goes below zero when the balance does', async () => {
    const { h, stripe, charge } = await paid({}, on);
    await spend(h, 'all', 24_000_000);
    stripe.dashboardRefund(charge, 2000);
    await send(h, stripe, { id: 'evt_r', type: 'charge.refunded', data: { object: { ...charge } } });
    await flush(h);
    const row = await snapshot(h);
    expect(row.sold_outstanding).toBe(0);
    expect(row.free_outstanding).toBe(0);
  });
});

describe('at least once, and rebuildable', () => {
  it('a late retry cannot overwrite newer numbers', async () => {
    const { h } = await paid({}, on);
    await flush(h);
    const [row] = await days(h);
    await revenueDb
      .prepare('UPDATE billing_daily SET version = version + 100, top_ups = 1 WHERE account = ? AND day = ?')
      .bind(row.account, row.day)
      .run();
    await spend(h, 'older-version', 1000);
    await flush(h);
    expect((await days(h))[0].top_ups).toBe(1);
  });

  it('pushing the same day twice changes nothing', async () => {
    const { h, ledger } = await paid({}, on);
    await flush(h);
    const before = await days(h);
    await ledger.rollupRebuild();
    await flush(h);
    const { version: _a, ...first } = before[0];
    const { version: _b, ...second } = (await days(h))[0];
    expect(second).toEqual(first);
  });

  it('rebuilds D1 from the ledger, to the same numbers the entries wrote', async () => {
    const { h, key, ledger } = await paid({}, on);
    await admin(h, '/refund', refundBody(key, 3));
    await flush(h);
    const before = await days(h);
    await revenueDb.prepare('DELETE FROM billing_daily WHERE account = ?').bind(h.platform.account).run();
    await revenueDb.prepare('DELETE FROM billing_accounts WHERE account = ?').bind(h.platform.account).run();
    await deliver(h, { kind: 'rollup', account: h.platform.account });
    await flush(h);
    const { version: _a, ...first } = before[0];
    const { version: _b, ...second } = (await days(h))[0];
    expect(second).toEqual(first);
    expect(await snapshot(h)).toMatchObject({ first_paid_day: today() });
    expect((await ledger.balance()).balance).toBeGreaterThan(0);
  });

  it('backfills a ledger from before the rollup existed, day by day', async () => {
    const h = harness();
    await on(h);
    const stub = ledgerStub(h.env, h.platform.account);
    await runInDurableObject(stub as unknown as DurableObjectStub, (_i, state) => {
      const sql = state.storage.sql;
      undoRollup(sql);
      sql.exec('UPDATE schema_version SET version = 4');
      for (const [key, at, amount] of [['grant:topup:topup-1', Date.UTC(2026, 8, 1, 12), 20_000_000], ['grant:topup:topup-2', Date.UTC(2026, 8, 3, 12), 20_000_000]] as const)
        sql.exec("INSERT INTO entries (key, at, kind, amount) VALUES (?, ?, 'grant', ?)", key, at, amount);
      expect(migrate(sql, LEDGER_SCHEMA)).toBe(LEDGER_SCHEMA.length);
      expect(migrate(sql, LEDGER_SCHEMA)).toBe(LEDGER_SCHEMA.length);
    });
    await stub.rollupRebuild();
    await flush(h);
    expect((await days(h)).map((d: any) => [d.day, d.top_ups])).toEqual([['2026-09-01', 20_000_000], ['2026-09-03', 20_000_000]]);
  });

  it('pushes a long history in batches, without dropping a day', async () => {
    const h = harness();
    await on(h);
    const stub = ledgerStub(h.env, h.platform.account);
    await runInDurableObject(stub as unknown as DurableObjectStub, (_i, state) => {
      for (let n = 0; n < 70; n++)
        state.storage.sql.exec("INSERT INTO entries (key, at, kind, amount) VALUES (?, ?, 'grant', 1)", `grant:old-${n}`, Date.UTC(2026, 0, 1 + n, 12));
    });
    await stub.rollupRebuild();
    await flush(h);
    await flush(h);
    await flush(h);
    expect(await days(h)).toHaveLength(70);
    expect(await pending(h)).toEqual([]);
  });

  it('queues rebuilds only with the bearer and the switch', async () => {
    const { h } = await paid();
    const post = (body: unknown, bearer = 'fixture-admin-token', env = h.env) =>
      managedFetch(new Request('https://managed.example.com/admin/billing/rollup', { method: 'POST', headers: { authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) }), env);
    expect((await post({ accounts: [h.platform.account] }, 'wrong')).status).toBe(401);
    expect((await post({ accounts: [h.platform.account] }, undefined, { ...h.env, ADMIN_BILLING: 'off' })).status).toBe(404);
    expect((await post({ accounts: ['Not An Account!'] })).status).toBe(400);
    expect((await post({ accounts: new Array(101).fill('abc') })).status).toBe(400);
    expect((await post({ accounts: [h.platform.account] })).status).toBe(202);
    expect(h.sent).toContainEqual({ kind: 'rollup', account: h.platform.account });
  });
});

describe('the reconcile checks the rollup too', () => {
  const mismatches = () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    return () => spy.mock.calls.map(([l]) => { try { return JSON.parse(String(l)); } catch { return null; } }).filter((e) => e?.event === 'billing.reconcile.mismatch');
  };

  it('stays quiet when D1 agrees with the ledger', async () => {
    const read = mismatches();
    const { h, key } = await paid({}, on);
    await admin(h, '/refund', refundBody(key, 5));
    await flush(h);
    await deliver(h, { kind: 'reconcile', account: h.platform.account });
    expect(read()).toEqual([]);
  });

  it('flags D1 that drifted from the ledger, and changes nothing', async () => {
    const read = mismatches();
    const { h } = await paid({}, on);
    await flush(h);
    await revenueDb.prepare('UPDATE billing_daily SET top_ups = 1 WHERE account = ?').bind(h.platform.account).run();
    await deliver(h, { kind: 'reconcile', account: h.platform.account });
    expect(read()).toEqual([expect.objectContaining({ problem: 'rollup_total', ledger_usd: 20, rollup_usd: 0.000001 })]);
    expect((await days(h))[0].top_ups).toBe(1);
  });

  it('does not call a day still waiting to be pushed a difference', async () => {
    const read = mismatches();
    const { h } = await paid({}, on);
    await deliver(h, { kind: 'reconcile', account: h.platform.account });
    expect(read()).toEqual([]);
  });
});
