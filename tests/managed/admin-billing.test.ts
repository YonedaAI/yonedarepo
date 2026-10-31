// What operators see of an account's billing, behind ADMIN_BILLING and the admin bearer: the
// balance, top-ups with their Stripe ids, the ledger paged, usage per agent run, the card (brand
// and last four only), auto top-up and a link to the Stripe customer; and the ledger's schema v4.
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ledgerStub } from '../../cloudflare/managed/ledger';
import { LEDGER_SCHEMA, migrate } from '../../cloudflare/managed/schema';
import { admin, paid, spend, withCard } from './billing-fixture';
import { harness } from './fake';
import { undoRollup } from './rollup-fixture';

afterEach(() => vi.restoreAllMocks());

describe('seeing an account', () => {
  it('answers 404 until ADMIN_BILLING is on, and 401 without the bearer', async () => {
    const off = await paid({ ADMIN_BILLING: undefined });
    expect((await admin(off.h, '')).status).toBe(404);
    const { h } = await paid();
    expect((await admin(h, '', undefined, 'wrong-token')).status).toBe(401);
    expect((await admin(h, '')).status).toBe(200);
  });

  it('shows the balance, top-ups with Stripe ids, card, auto top-up and the customer link', async () => {
    const { h, key, charge } = await paid();
    const res = await admin(h, '');
    const view = await res.json<any>();
    expect(view).toMatchObject({
      workspace: h.platform.account,
      card: { brand: 'visa', last4: '4242' },
      auto_top_up: true,
      paused: null,
      refund: { configured: true, max_usd: 500, daily_usd: 100000000 },
    });
    expect(view.balance.balance_usd).toBeCloseTo(24.999, 2);
    expect(view.customer).toMatch(/^cus_/);
    expect(view.stripe_url).toBe(`https://dashboard.stripe.com/test/customers/${view.customer}`);
    expect(view.top_ups).toEqual([
      expect.objectContaining({
        id: key,
        amount_usd: 20,
        status: 'succeeded',
        payment_intent: charge.payment_intent,
        refunded_usd: 0,
        frozen_usd: 0,
        unspent_usd: 20,
        refundable_usd: 20,
        disputed: false,
      }),
    ]);
    expect(JSON.stringify(view)).not.toContain('pm_card_1');
  });

  it('counts credit as spent oldest first, so the newest top-up is unspent longest', async () => {
    const { h, key } = await paid();
    // The balance is just under $25: $5 of older credit and the $20 top-up.
    await spend(h, 'older', 4_000_000);
    expect((await (await admin(h, '')).json<any>()).top_ups[0]).toMatchObject({ id: key, unspent_usd: 20 });
    await spend(h, 'into-it', 6_000_000);
    const unspent = (await (await admin(h, '')).json<any>()).top_ups[0].unspent_usd;
    expect(unspent).toBeCloseTo(14.999, 2);
  });

  it('counts an open hold as spent: that credit is not there to refund', async () => {
    const { h, ledger } = await paid();
    const meta = { repo: h.platform.repo, run: 'held', agent: 'code-review', model: 'm' };
    await ledger.hold('held', 15_000_000, meta);
    expect((await (await admin(h, '')).json<any>()).top_ups[0].unspent_usd).toBeCloseTo(9.999, 2);
  });

  it('pages the ledger, newest first', async () => {
    const { h } = await withCard();
    for (const n of [1, 2, 3, 4, 5]) await spend(h, `s${n}`, 1000 * n);
    const first = await (await admin(h, '/ledger?limit=3')).json<any>();
    expect(first.items).toHaveLength(3);
    expect(first.items[0]).toMatchObject({ kind: 'charge' });
    const second = await (await admin(h, `/ledger?limit=3&before=${first.next}`)).json<any>();
    const ids = [...first.items, ...second.items].map((e: any) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(6);
    expect(JSON.stringify(first)).not.toContain('pm_card_1');
  });

  it('pages usage per agent run, charges only', async () => {
    const { h } = await withCard();
    await spend(h, 'a', 1_000_000);
    await spend(h, 'b', 2_000_000);
    await spend(h, 'c', 3_000_000);
    const first = await (await admin(h, '/usage?limit=2')).json<any>();
    expect(first.items).toEqual([
      expect.objectContaining({ run: 'run-c', repo: h.platform.repo, agent: 'code-review', charged_usd: 3, calls: 1 }),
      expect.objectContaining({ run: 'run-b', charged_usd: 2 }),
    ]);
    const second = await (await admin(h, `/usage?limit=2&before=${first.next}`)).json<any>();
    expect(second.items.map((u: any) => u.run)).toEqual(['run-a']);
    expect(second.next).toBeNull();
  });

  it('shows an empty account as no customer, no card and no top-ups', async () => {
    const h = harness(undefined, { ADMIN_BILLING: 'on' } as never);
    const view = await (await admin(h, '')).json<any>();
    expect(view).toMatchObject({
      customer: null,
      stripe_url: null,
      card: null,
      top_ups: [],
      refunds: [],
      disputes: [],
      refund: { configured: false, max_usd: null, daily_usd: null },
    });
  });
});

describe('ledger schema v4', () => {
  it('upgrades a v3 ledger, keeping its card, top-ups and entries, and applies once', async () => {
    const stub = ledgerStub(harness().env, `ws-${crypto.randomUUID()}`);
    await runInDurableObject(stub as unknown as DurableObjectStub, (_instance, state) => {
      const sql = state.storage.sql;
      undoRollup(sql);
      for (const table of ['refunds', 'disputes', 'refund_days', 'billing', 'top_ups']) sql.exec(`DROP TABLE ${table}`);
      sql.exec(LEDGER_SCHEMA[1]);
      sql.exec(LEDGER_SCHEMA[2]);
      sql.exec('UPDATE schema_version SET version = 3');
      sql.exec("INSERT INTO billing (id, customer, payment_method, auto_top_up) VALUES (1, 'cus', 'pm', 0)");
      sql.exec("INSERT INTO top_ups (key, amount, status, payment_intent, created_at) VALUES ('topup-1', 20000000, 'succeeded', 'pi', 1)");
      sql.exec("INSERT INTO entries (key, at, kind, amount) VALUES ('grant:topup:topup-1', 1, 'grant', 20000000)");
      expect(migrate(sql, LEDGER_SCHEMA)).toBe(LEDGER_SCHEMA.length);
      expect(migrate(sql, LEDGER_SCHEMA)).toBe(LEDGER_SCHEMA.length);
      expect(sql.exec('SELECT payment_method, auto_top_up, paused_at FROM billing').toArray()).toEqual([
        { payment_method: 'pm', auto_top_up: 0, paused_at: null },
      ]);
      expect(sql.exec('SELECT key, stripe_refunded FROM top_ups').toArray()).toEqual([{ key: 'topup-1', stripe_refunded: 0 }]);
      expect(sql.exec('SELECT COUNT(*) AS n FROM refunds').one().n).toBe(0);
      expect(sql.exec('SELECT COUNT(*) AS n FROM disputes').one().n).toBe(0);
    });
  });
});
