// The nightly reconcile, started by the platform Worker's cron: Stripe names the accounts with a
// charge or a refund in the last two days, and each one's ledger is compared with its charges.
// Read-only: it logs what differs (event `billing.reconcile.mismatch`) and changes nothing, here
// or at Stripe. An open refund is no mismatch, whether or not Stripe has it yet. The revenue
// rollup is held to the ledger the same way, so the chain Stripe, ledger, rollup is all checked.
import type { ManagedEnv, QueueMessage } from './config';
import { ledgerStub } from './ledger';
import { activeAccounts, customerCharges } from './stripe-admin';

const WINDOW_S = 2 * 86_400;
const BATCH = 100;

export async function reconcileAll(env: ManagedEnv, now = Date.now()) {
  const accounts = await activeAccounts(env, Math.floor(now / 1000) - WINDOW_S);
  for (let i = 0; i < accounts.length; i += BATCH)
    await env.RUNS.sendBatch(
      accounts
        .slice(i, i + BATCH)
        .map((account) => ({ body: { kind: 'reconcile', account } as QueueMessage })),
    );
}

type TopUp = {
  key: string;
  amount: number;
  status: string;
  settled: number;
  open: number;
  disputes: number;
};
type Mismatch = { problem: string; top_up: string; ledger_usd?: number; stripe_usd?: number };

/** Top-ups and settled refunds as the ledger and as D1 hold them. Days still waiting to be pushed
 * are not a difference; the caller skips the check while any do. */
async function rollupProblems(env: ManagedEnv, account: string, topUps: TopUp[]) {
  if (!env.REVENUE) return [];
  const row = await env.REVENUE.prepare(
    `SELECT COALESCE(SUM(top_ups), 0) AS top_ups, COALESCE(SUM(refunds), 0) AS refunds
     FROM billing_daily WHERE account = ?`,
  )
    .bind(account)
    .first<{ top_ups: number; refunds: number }>();
  const paid = topUps.filter((t) => t.status === 'succeeded');
  const ledger = {
    top_ups: paid.reduce((sum, t) => sum + t.amount, 0),
    refunds: topUps.reduce((sum, t) => sum + t.settled, 0),
  };
  return (['top_ups', 'refunds'] as const)
    .filter((field) => (row?.[field] ?? 0) !== ledger[field])
    .map((field) => ({
      problem: 'rollup_total',
      field,
      ledger_usd: usd(ledger[field]),
      rollup_usd: usd(row?.[field] ?? 0),
    }));
}

const usd = (micro: number) => micro / 1_000_000;

/** What differs between one charge and its top-up. */
function chargeProblems(charge: Record<string, any>, key: string, t: TopUp | undefined) {
  if (t?.status !== 'succeeded') return [{ problem: 'charge_without_top_up', top_up: key }];
  const problems: Mismatch[] = [];
  const captured = Number(charge.amount_captured) * 10_000;
  const refunded = Number(charge.amount_refunded) * 10_000;
  if (captured !== t.amount)
    problems.push({
      problem: 'amount',
      top_up: key,
      ledger_usd: usd(t.amount),
      stripe_usd: usd(captured),
    });
  if (refunded < t.settled || refunded > t.settled + t.open)
    problems.push({
      problem: 'refund_total',
      top_up: key,
      ledger_usd: usd(t.settled),
      stripe_usd: usd(refunded),
    });
  if (charge.disputed === true && t.disputes === 0)
    problems.push({ problem: 'dispute_missing', top_up: key });
  return problems;
}

/** `complete`: every charge was read, so a top-up without one really has none. */
function compare(charges: Record<string, any>[], topUps: TopUp[], complete: boolean) {
  const byKey = new Map(topUps.map((t) => [t.key, t]));
  const seen = new Set<string>();
  const problems: Mismatch[] = [];
  for (const charge of charges) {
    const key = charge.metadata?.top_up;
    if (typeof key !== 'string' || charge.status !== 'succeeded') continue;
    seen.add(key);
    problems.push(...chargeProblems(charge, key, byKey.get(key)));
  }
  if (complete)
    for (const t of topUps)
      if (t.status === 'succeeded' && !seen.has(t.key))
        problems.push({ problem: 'top_up_without_charge', top_up: t.key });
  return problems;
}

export async function reconcileAccount(env: ManagedEnv, account: string) {
  const { customer, top_ups, rollup_pending } = await ledgerStub(env, account).reconcileState();
  if (!customer) return;
  const { data, complete } = await customerCharges(env, customer);
  const rollup = rollup_pending ? [] : await rollupProblems(env, account, top_ups);
  for (const mismatch of [...compare(data, top_ups, complete), ...rollup])
    console.error(JSON.stringify({ event: 'billing.reconcile.mismatch', account, ...mismatch }));
}
