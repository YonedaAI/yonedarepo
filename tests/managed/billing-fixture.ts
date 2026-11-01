// A workspace that has paid Stripe: a saved card, its credit spent down, one automatic top-up
// charged, and the operators' admin routes (ADMIN_BILLING on, the fixture bearer, the refund
// key). Stripe is the fake: no network and no card.
import { expect, vi } from 'vitest';
import { AUTO_TOP_UP } from '../../shared/managed-agents';
import type { QueueMessage } from '../../cloudflare/managed/config';
import { consume } from '../../cloudflare/managed/dispatch';
import { managedFetch } from '../../cloudflare/managed/index';
import { ledgerStub } from '../../cloudflare/managed/ledger';
import {
  FakeStripe,
  fakeGateway,
  type Harness,
  harness,
  newRepo,
  STRIPE_BASE,
  STRIPE_KEY,
  STRIPE_REFUND_KEY,
  STRIPE_WEBHOOK_SECRET,
} from './fake';

export const billingEnv = {
  STRIPE_SECRET_KEY: STRIPE_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_API_BASE: STRIPE_BASE,
  STRIPE_REFUND_KEY,
  PROMO_CREDIT_USD: '100',
  ADMIN_BILLING: 'on',
  REFUND_MAX_USD: '500',
  REFUND_DAILY_USD: '100000000',
};

export const deliver = async (h: Harness, ...bodies: QueueMessage[]) => {
  const messages = bodies.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }));
  await consume({ messages } as unknown as MessageBatch<QueueMessage>, h.env);
  return messages;
};

/** An operator's route on the managed Worker, as the platform calls it. */
export const admin = (h: Harness, path: string, body?: unknown, bearer = 'fixture-admin-token', account = h.platform.account) =>
  managedFetch(
    new Request(`https://managed.example.com/admin/accounts/${account}/billing${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    h.env,
  );

export const browserApi = (h: Harness, path: string, init: RequestInit = {}) =>
  managedFetch(
    new Request(`https://site.example.com/api/managed/workspaces/${h.platform.account}${path}`, {
      ...init,
      headers: { cookie: 'session=owner', 'content-type': 'application/json' },
    }),
    h.env,
  );

export async function withCard(
  stripe = new FakeStripe(),
  overrides: Record<string, unknown> = {},
  before?: (h: Harness) => Promise<void>,
) {
  const h = harness(newRepo(), { ...billingEnv, ...overrides } as never);
  await before?.(h);
  fakeGateway(undefined, stripe);
  const setup = await browserApi(h, '/billing/setup', {
    method: 'POST',
    body: JSON.stringify({ return_path: '/settings' }),
  });
  expect(setup.status).toBe(200);
  const session = stripe.calls.find((c) => c.path === '/v1/checkout/sessions');
  const event = {
    id: 'evt_setup',
    type: 'setup_intent.succeeded',
    data: {
      object: {
        id: 'seti_1',
        payment_method: 'pm_card_1',
        customer: session?.form.customer,
        metadata: { workspace: h.platform.account },
      },
    },
  };
  expect((await managedFetch(await stripe.webhook(event), h.env)).status).toBe(200);
  return { h, stripe };
}

export const spend = async (h: Harness, key: string, amount: number) => {
  const ledger = ledgerStub(h.env, h.platform.account);
  const meta = { repo: h.platform.repo, run: `run-${key}`, agent: 'code-review', model: 'm' };
  await ledger.hold(key, amount, meta);
  return ledger.settle(key, null, true, meta);
};

/** A workspace whose $20 automatic top-up was charged: the balance is just under $25, all of
 * the top-up unspent. */
export async function paid(
  overrides: Record<string, unknown> = {},
  before?: (h: Harness) => Promise<void>,
) {
  const { h, stripe } = await withCard(new FakeStripe(), overrides, before);
  const ledger = ledgerStub(h.env, h.platform.account);
  const left = (await ledger.balance()).balance;
  const key = await spend(h, 'spend', left - (AUTO_TOP_UP.below_usd * 1_000_000 - 1000));
  expect(key).toMatch(/^topup-\d+$/);
  await deliver(h, { kind: 'topup', account: h.platform.account, key: key as string });
  const charge = [...stripe.charges.values()][0];
  return { h, stripe, ledger, key: key as string, charge };
}

export const refundBody = (top_up: string, usd: number, extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  top_up,
  usd,
  reason: 'Customer asked for it back',
  actor: 'boss',
  ...extra,
});
