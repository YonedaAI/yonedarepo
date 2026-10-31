// An operator's other billing actions on the managed Worker: goodwill credit, auto top-up off,
// removing the card and pausing billing, each with a reason.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ledgerStub } from '../../cloudflare/managed/ledger';
import { admin, browserApi, deliver, paid, spend, withCard } from './billing-fixture';

afterEach(() => vi.restoreAllMocks());

const act = { reason: 'Support ticket 1234', actor: 'boss' };
const state = async (h: Parameters<typeof admin>[0]) => (await admin(h, '')).json<any>();

describe('goodwill credit', () => {
  it('adds credit once per id, hands back waiting runs, and shows the reason on the ledger', async () => {
    const { h } = await withCard();
    const ledger = ledgerStub(h.env, h.platform.account);
    const before = (await ledger.balance()).balance;
    await ledger.pause(h.platform.repo, 'waiting');
    const body = { ...act, id: crypto.randomUUID(), usd: 12.5 };
    expect((await admin(h, '/credit', body)).status).toBe(200);
    expect((await admin(h, '/credit', body)).status).toBe(200);
    expect((await ledger.balance()).balance).toBe(before + 12_500_000);
    expect(h.sent).toContainEqual({ kind: 'resume', repo: h.platform.repo, run: 'waiting' });
    const page = await (await admin(h, '/ledger')).json<any>();
    expect(page.items[0]).toMatchObject({ kind: 'grant', amount_usd: 12.5, note: 'Goodwill: Support ticket 1234' });
  });

  it('requires a reason and a sensible amount', async () => {
    const { h } = await withCard();
    for (const bad of [{ reason: '' }, { usd: 0 }, { usd: 1000.01 }, { usd: 1.005 }, { id: 'x' }])
      expect((await admin(h, '/credit', { ...act, id: crypto.randomUUID(), usd: 1, ...bad })).status, JSON.stringify(bad)).toBe(400);
  });
});

describe('the card', () => {
  it('turns auto top-up off, keeping the card', async () => {
    const { h, ledger } = await paid();
    const res = await admin(h, '/auto-top-up-off', act);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ auto_top_up: false, card: { last4: '4242' } });
    expect(await spend(h, 'low', (await ledger.balance()).balance - 1_000_000)).toBeNull();
    expect((await (await browserApi(h, '/billing')).json<any>()).auto_top_up.enabled).toBe(false);
  });

  it('removes the card at Stripe', async () => {
    const { h, stripe } = await paid();
    const res = await admin(h, '/remove-card', act);
    expect(await res.json()).toMatchObject({ card: null });
    expect(stripe.detached).toEqual(['pm_card_1']);
  });

  it('requires a reason for both', async () => {
    const { h, stripe } = await paid();
    for (const path of ['/auto-top-up-off', '/remove-card'])
      expect((await admin(h, path, { reason: ' ', actor: 'boss' })).status, path).toBe(400);
    expect(stripe.detached).toEqual([]);
  });
});

describe('pausing billing', () => {
  it('stops the card being charged, leaves the credit usable, and lifts', async () => {
    const { h, stripe, ledger } = await paid();
    const res = await admin(h, '/pause', { ...act, paused: true });
    expect((await res.json<any>()).paused).toMatchObject({ reason: act.reason, by: 'boss' });
    const left = (await ledger.balance()).balance;
    expect(await spend(h, 'low', left - 1_000_000)).toBeNull();
    expect((await ledger.balance()).balance).toBe(1_000_000);
    expect((await (await browserApi(h, '/billing')).json<any>()).auto_top_up.enabled).toBe(true);
    const lifted = await admin(h, '/pause', { ...act, paused: false });
    expect((await lifted.json<any>()).paused).toBeNull();
    expect(await spend(h, 'more', 100_000)).toMatch(/^topup-/);
    expect(stripe.intents.size).toBe(1);
  });

  it('drops a top-up queued before the pause, without blaming the card', async () => {
    const { h, stripe, ledger } = await paid();
    const key = (await spend(h, 'low', (await ledger.balance()).balance - 1_000_000)) as string;
    await admin(h, '/pause', { ...act, paused: true });
    await deliver(h, { kind: 'topup', account: h.platform.account, key });
    expect(stripe.intents.size).toBe(1);
    const view = await state(h);
    expect(view.top_ups.find((t: any) => t.id === key)).toMatchObject({ status: 'failed', error: 'Billing paused' });
    expect(view.top_up_failed).toBeNull();
  });

  it('requires a reason, and paused true or false', async () => {
    const { h } = await paid();
    expect((await admin(h, '/pause', { reason: '', actor: 'boss', paused: true })).status).toBe(400);
    expect((await admin(h, '/pause', { ...act, paused: 'yes' })).status).toBe(400);
  });
});
