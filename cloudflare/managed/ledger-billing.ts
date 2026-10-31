// A workspace's card billing inside its CreditLedger: the Stripe customer, the saved card
// (payment method id, brand, last four), whether the last top-up failed, whether automatic
// top-up is on, and the top-ups.
// Functions over the ledger's SQL, each called inside one of its transactions.
import { AUTO_TOP_UP, type CardOnFile, type TopUp } from '../../shared/managed-agents';

type BillingRow = {
  customer: string | null;
  payment_method: string | null;
  brand: string | null;
  last4: string | null;
  card_added_at: number | null;
  top_up_failed: string | null;
  auto_top_up: number;
  paused_at: number | null;
  paused_reason: string | null;
  paused_by: string | null;
};

const EMPTY: BillingRow = {
  customer: null,
  payment_method: null,
  brand: null,
  last4: null,
  card_added_at: null,
  top_up_failed: null,
  auto_top_up: 1,
  paused_at: null,
  paused_reason: null,
  paused_by: null,
};

export function billingRow(sql: SqlStorage): BillingRow {
  return sql.exec<BillingRow>('SELECT * FROM billing WHERE id = 1').toArray()[0] ?? EMPTY;
}

export const cardOf = (row: BillingRow): CardOnFile | null =>
  row.payment_method && row.card_added_at !== null
    ? { brand: row.brand ?? 'card', last4: row.last4 ?? '????', added_at: row.card_added_at }
    : null;

function upsert(sql: SqlStorage, fields: Partial<BillingRow>) {
  const next = { ...billingRow(sql), ...fields };
  sql.exec(
    `INSERT INTO billing (id, customer, payment_method, brand, last4, card_added_at, top_up_failed,
       auto_top_up, paused_at, paused_reason, paused_by)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET customer = excluded.customer,
       payment_method = excluded.payment_method, brand = excluded.brand, last4 = excluded.last4,
       card_added_at = excluded.card_added_at, top_up_failed = excluded.top_up_failed,
       auto_top_up = excluded.auto_top_up, paused_at = excluded.paused_at,
       paused_reason = excluded.paused_reason, paused_by = excluded.paused_by`,
    next.customer,
    next.payment_method,
    next.brand,
    next.last4,
    next.card_added_at,
    next.top_up_failed,
    next.auto_top_up,
    next.paused_at,
    next.paused_reason,
    next.paused_by,
  );
}

export const setCustomer = (sql: SqlStorage, customer: string) => upsert(sql, { customer });

/** Automatic top-up on or off; the card stays saved either way. */
export const setAutoTopUp = (sql: SqlStorage, enabled: boolean) =>
  upsert(sql, { auto_top_up: enabled ? 1 : 0 });

/** A newly saved card replaces the old one and clears a failed top-up. */
export function recordCard(
  sql: SqlStorage,
  card: { payment_method: string; brand: string; last4: string },
  now: number,
) {
  upsert(sql, { ...card, card_added_at: now, top_up_failed: null });
}

/** An operator's pause on charging the card (null lifts it); the credit stays usable. */
export function setBillingPaused(
  sql: SqlStorage,
  pause: { at: number; reason: string; by: string } | null,
) {
  upsert(sql, {
    paused_at: pause?.at ?? null,
    paused_reason: pause?.reason ?? null,
    paused_by: pause?.by ?? null,
  });
}

export function forgetCard(sql: SqlStorage) {
  upsert(sql, { payment_method: null, brand: null, last4: null, card_added_at: null });
}

/** An operator's pause or an open dispute stops the card being charged, whatever the
 * customer's own switch says. */
const chargingStopped = (sql: SqlStorage, row: BillingRow) =>
  row.paused_at !== null ||
  sql.exec("SELECT 1 FROM disputes WHERE status = 'open' LIMIT 1").toArray().length > 0;

/**
 * The top-up the balance now calls for, recorded as pending, or null: only with a card on file,
 * automatic top-up on, no failed top-up waiting on a new card, no other top-up pending, charging
 * not stopped, and the balance below the threshold. Its key (`topup-<n>`) is its idempotency key
 * at Stripe.
 */
export function topUpDue(sql: SqlStorage, balance: number, now: number): string | null {
  const row = billingRow(sql);
  if (!row.payment_method || !row.auto_top_up || row.top_up_failed) return null;
  if (chargingStopped(sql, row)) return null;
  if (balance >= AUTO_TOP_UP.below_usd * 1_000_000) return null;
  const pending = sql.exec("SELECT 1 FROM top_ups WHERE status = 'pending'").toArray().length;
  if (pending) return null;
  const n = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM top_ups').one().n + 1;
  const key = `topup-${n}`;
  sql.exec(
    "INSERT INTO top_ups (key, amount, status, created_at) VALUES (?, ?, 'pending', ?)",
    key,
    AUTO_TOP_UP.add_usd * 1_000_000,
    now,
  );
  return key;
}

export interface PendingTopUp {
  key: string;
  amount: number;
  status: TopUp['status'];
  customer: string | null;
  payment_method: string | null;
  /** Charging stopped since it was queued: it must not reach the card. */
  stopped: boolean;
}

export function topUp(sql: SqlStorage, key: string): PendingTopUp | null {
  const row = sql
    .exec<{ key: string; amount: number; status: TopUp['status'] }>(
      'SELECT key, amount, status FROM top_ups WHERE key = ?',
      key,
    )
    .toArray()[0];
  if (!row) return null;
  const billing = billingRow(sql);
  return {
    ...row,
    customer: billing.customer,
    payment_method: billing.payment_method,
    stopped: chargingStopped(sql, billing),
  };
}

/** A pending top-up dropped because charging stopped: nothing failed at the card, so nothing
 * tells the customer to replace it. */
export function cancelTopUp(sql: SqlStorage, key: string, now: number) {
  sql.exec(
    "UPDATE top_ups SET status = 'failed', error = 'Billing paused', settled_at = ? WHERE key = ? AND status = 'pending'",
    now,
    key,
  );
}

/** Records a top-up's outcome once; answers its amount when it newly succeeded. */
export function settleTopUp(
  sql: SqlStorage,
  key: string,
  outcome: { ok: true; intent: string } | { ok: false; error: string },
  now: number,
): number | null {
  const row = sql
    .exec<{ amount: number; status: string }>(
      'SELECT amount, status FROM top_ups WHERE key = ?',
      key,
    )
    .toArray()[0];
  if (!row || row.status === 'succeeded') return null;
  if (outcome.ok) {
    sql.exec(
      "UPDATE top_ups SET status = 'succeeded', payment_intent = ?, error = NULL, settled_at = ? WHERE key = ?",
      outcome.intent,
      now,
      key,
    );
    return row.amount;
  }
  if (row.status === 'pending') {
    sql.exec(
      "UPDATE top_ups SET status = 'failed', error = ?, settled_at = ? WHERE key = ?",
      outcome.error.slice(0, 300),
      now,
      key,
    );
    upsert(sql, { top_up_failed: outcome.error.slice(0, 300) });
  }
  return null;
}

export function topUps(sql: SqlStorage, limit = 50): TopUp[] {
  return sql
    .exec<{
      key: string;
      amount: number;
      status: TopUp['status'];
      error: string | null;
      created_at: number;
    }>(
      'SELECT key, amount, status, error, created_at FROM top_ups ORDER BY created_at DESC, key DESC LIMIT ?',
      limit,
    )
    .toArray()
    .map((r) => ({
      id: r.key,
      amount_usd: r.amount / 1_000_000,
      status: r.status,
      error: r.error,
      created_at: r.created_at,
    }));
}
