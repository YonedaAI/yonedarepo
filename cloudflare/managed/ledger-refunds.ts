// Refunds inside a CreditLedger, over its SQL and each called in one of its transactions. The
// ledger never spends by top-up, so what is left of one is a rule: credit is spent oldest first
// (promotional credit before a later top-up, which favours the customer), and what the balance
// holds now is the newest credit. What takes credit back is a negative 'grant' with a key of its
// own (schema v4): the balance stays the sum of every entry and `used` stays what agents used.
import { balanceOf, insertEntry } from './ledger-holds';

export type TopUpRow = {
  key: string;
  amount: number;
  status: 'pending' | 'succeeded' | 'failed';
  payment_intent: string | null;
  error: string | null;
  created_at: number;
  stripe_refunded: number;
};

export type RefundRow = {
  id: string;
  account: string;
  top_up: string;
  amount: number;
  status: 'open' | 'succeeded' | 'failed';
  origin: 'operator' | 'stripe';
  actor: string;
  reason: string;
  spent_override: number;
  stripe_refund: string | null;
  error: string | null;
  created_at: number;
  settled_at: number | null;
};

/** Per top-up, what refunds took or are taking (`refunded`) and what disputes froze (`frozen`:
 * open ones, and lost ones, whose credit never comes back). */
export function takenBack(sql: SqlStorage) {
  const out = new Map<string, { refunded: number; frozen: number }>();
  const entry = (key: string) => {
    const row = out.get(key) ?? { refunded: 0, frozen: 0 };
    out.set(key, row);
    return row;
  };
  const refunded = sql.exec<{ top_up: string; n: number }>(
    `SELECT top_up, SUM(amount) AS n FROM refunds WHERE status IN ('open','succeeded')
     GROUP BY top_up`,
  );
  for (const row of refunded) entry(row.top_up).refunded = row.n;
  const frozen = sql.exec<{ top_up: string; n: number }>(
    `SELECT top_up, SUM(frozen) AS n FROM disputes
     WHERE status IN ('open','lost') AND top_up IS NOT NULL GROUP BY top_up`,
  );
  for (const row of frozen) entry(row.top_up).frozen = row.n;
  return out;
}

/** What each top-up still holds of the balance: the balance read as the newest credit first. */
export function unspentByTopUp(sql: SqlStorage): Map<string, number> {
  const back = takenBack(sql);
  const out = new Map<string, number>();
  let left = Math.max(0, balanceOf(sql).balance);
  const grants = sql.exec<{ key: string; amount: number }>(
    "SELECT key, amount FROM entries WHERE kind = 'grant' AND key LIKE 'grant:%' ORDER BY id DESC",
  );
  for (const grant of grants) {
    const topUp = grant.key.startsWith('grant:topup:') ? grant.key.slice(12) : null;
    const taken = topUp ? back.get(topUp) : undefined;
    const value = Math.max(0, grant.amount - (taken?.refunded ?? 0) - (taken?.frozen ?? 0));
    const share = Math.min(value, left);
    left -= share;
    if (topUp) out.set(topUp, share);
  }
  return out;
}

export function topUpRows(sql: SqlStorage, limit = 50) {
  return sql
    .exec<TopUpRow>(
      `SELECT key, amount, status, payment_intent, error, created_at, stripe_refunded
       FROM top_ups ORDER BY created_at DESC, key DESC LIMIT ?`,
      limit,
    )
    .toArray();
}

export const refundRows = (sql: SqlStorage, limit = 50) =>
  sql.exec<RefundRow>('SELECT * FROM refunds ORDER BY created_at DESC LIMIT ?', limit).toArray();

export type RefundAsk = {
  id: string;
  account: string;
  top_up: string;
  amount: number;
  reason: string;
  actor: string;
  spent_override: boolean;
  allow_negative: boolean;
};
export type RefundRefusal = { ok: false; code: string; message: string; status: number };
export type RefundAnswer = { ok: true; replay: boolean; refund: RefundRow } | RefundRefusal;

const refused = (code: string, message: string, status = 400): RefundRefusal => ({
  ok: false,
  code,
  message,
  status,
});
const dollars = (micro: number) =>
  `${micro < 0 ? '-' : ''}$${(Math.abs(micro) / 1_000_000).toFixed(2)}`;

export const refundRow = (sql: SqlStorage, id: string) =>
  sql.exec<RefundRow>('SELECT * FROM refunds WHERE id = ?', id).toArray()[0] ?? null;

const hasOpenDispute = (sql: SqlStorage, topUp: string) =>
  sql.exec("SELECT 1 FROM disputes WHERE top_up = ? AND status = 'open' LIMIT 1", topUp).toArray()
    .length > 0;

/**
 * Records a refund and takes its credit at once, before Stripe is asked, so the credit cannot
 * be spent while the outcome is unknown. The same id again answers the record (a double submit
 * or a retry). Everything a limit depends on is read in this transaction, so two refunds cannot
 * pass one together. Refused, nothing is written.
 */
export function refundIntent(sql: SqlStorage, ask: RefundAsk, now: number): RefundAnswer {
  const same = refundRow(sql, ask.id);
  if (same) {
    if (same.top_up === ask.top_up && same.amount === ask.amount)
      return { ok: true, replay: true, refund: same };
    return refused('CONFLICT', 'That refund id was used for another refund', 409);
  }
  const topUp = sql
    .exec<TopUpRow>(
      `SELECT key, amount, status, payment_intent, error, created_at, stripe_refunded
       FROM top_ups WHERE key = ?`,
      ask.top_up,
    )
    .toArray()[0];
  if (!topUp) return refused('NOT_FOUND', 'Unknown top-up', 404);
  if (topUp.status !== 'succeeded' || !topUp.payment_intent)
    return refused('NOT_REFUNDABLE', 'Only a charged top-up can be refunded');
  if (hasOpenDispute(sql, ask.top_up))
    return refused('DISPUTED', 'That top-up is disputed: no refund until the dispute closes', 409);
  const taken = takenBack(sql).get(ask.top_up);
  const refundable = topUp.amount - (taken?.refunded ?? 0) - (taken?.frozen ?? 0);
  if (ask.amount > refundable)
    return refused('OVER_REFUNDABLE', `At most ${dollars(refundable)} of it can be refunded`);
  const spent = ask.amount > (unspentByTopUp(sql).get(ask.top_up) ?? 0);
  if (spent && !ask.spent_override)
    return refused('SPENT_CREDIT', 'That is more than the unspent credit of this top-up');
  const after = balanceOf(sql).balance - ask.amount;
  if (after < 0 && !ask.allow_negative)
    return refused('NEGATIVE_BALANCE', `The balance would go to ${dollars(after)}`);
  sql.exec(
    `INSERT INTO refunds (id, account, top_up, amount, status, origin, actor, reason,
       spent_override, created_at)
     VALUES (?, ?, ?, ?, 'open', 'operator', ?, ?, ?, ?)`,
    ask.id,
    ask.account,
    ask.top_up,
    ask.amount,
    ask.actor,
    ask.reason,
    spent ? 1 : 0,
    now,
  );
  insertEntry(sql, `refund:${ask.id}`, 'grant', -ask.amount, { note: `Refund of ${ask.top_up}` });
  return { ok: true, replay: false, refund: refundRow(sql, ask.id) as RefundRow };
}

/** Stripe has the refund but has not finished it: the same refund, still open. */
export function refundAccepted(sql: SqlStorage, id: string, stripeRefund: string) {
  sql.exec(
    "UPDATE refunds SET stripe_refund = ? WHERE id = ? AND status = 'open'",
    stripeRefund,
    id,
  );
}

export function refundSucceeded(sql: SqlStorage, id: string, stripeRefund: string, now: number) {
  sql.exec(
    `UPDATE refunds SET status = 'succeeded', stripe_refund = ?, settled_at = ?
     WHERE id = ? AND status = 'open'`,
    stripeRefund,
    now,
    id,
  );
}

/** Stripe refused or failed the refund: its credit comes back, once. */
export function refundFailed(sql: SqlStorage, id: string, error: string, now: number) {
  const refund = refundRow(sql, id);
  if (refund?.status !== 'open') return false;
  sql.exec(
    "UPDATE refunds SET status = 'failed', error = ?, settled_at = ? WHERE id = ?",
    error.slice(0, 300),
    now,
    id,
  );
  insertEntry(sql, `refund-reversal:${id}`, 'grant', refund.amount, {
    note: `Refund of ${refund.top_up} failed`,
  });
  syncRefunded(sql, refund.top_up, now);
  return true;
}

export const openRefunds = (sql: SqlStorage) =>
  sql.exec<RefundRow>("SELECT * FROM refunds WHERE status = 'open' LIMIT 100").toArray();

/**
 * Makes the ledger agree with what Stripe says is refunded of a top-up: the amount no refund
 * here accounts for was refunded in Stripe's dashboard, and its credit is taken, even past
 * zero, because the money has already gone. Open refunds count, so one whose answer has not
 * reached the ledger is not taken twice. Keyed by the running total: a replay finds nothing to
 * add.
 */
export function syncRefunded(sql: SqlStorage, topUp: string, now: number) {
  const row = sql
    .exec<{ stripe_refunded: number }>('SELECT stripe_refunded FROM top_ups WHERE key = ?', topUp)
    .toArray()[0];
  if (!row) return;
  const missing = row.stripe_refunded - (takenBack(sql).get(topUp)?.refunded ?? 0);
  if (missing <= 0) return;
  const id = `stripe-${topUp}-${row.stripe_refunded}`;
  sql.exec(
    `INSERT INTO refunds (id, account, top_up, amount, status, origin, actor, reason, created_at,
       settled_at)
     VALUES (?, '', ?, ?, 'succeeded', 'stripe', 'stripe', 'Refunded in Stripe', ?, ?)`,
    id,
    topUp,
    missing,
    now,
    now,
  );
  insertEntry(sql, `refund:${id}`, 'grant', -missing, { note: `Refund of ${topUp} in Stripe` });
}

/** What Stripe says is refunded of a top-up, a running total: events can come out of order. */
export function stripeRefunded(sql: SqlStorage, topUp: string, total: number, now: number) {
  sql.exec(
    'UPDATE top_ups SET stripe_refunded = MAX(stripe_refunded, ?) WHERE key = ?',
    total,
    topUp,
  );
  syncRefunded(sql, topUp, now);
}

/** Each top-up with what the ledger holds to be refunded of it, settled and open, and whether
 * it knows of a dispute. */
export const reconcileRows = (sql: SqlStorage) =>
  sql
    .exec<{
      key: string;
      amount: number;
      status: string;
      settled: number;
      open: number;
      disputes: number;
    }>(
      `SELECT t.key, t.amount, t.status,
         (SELECT COALESCE(SUM(r.amount), 0) FROM refunds r
           WHERE r.top_up = t.key AND r.status = 'succeeded') AS settled,
         (SELECT COALESCE(SUM(r.amount), 0) FROM refunds r
           WHERE r.top_up = t.key AND r.status = 'open') AS open,
         (SELECT COUNT(*) FROM disputes d WHERE d.top_up = t.key) AS disputes
       FROM top_ups t ORDER BY t.created_at DESC LIMIT 500`,
    )
    .toArray();

/** Each day's refunds, on the limits instance: reserved before a refund, freed if it fails. */
export function reserveRefund(
  sql: SqlStorage,
  o: { id: string; amount: number; cap: number; day: string },
) {
  if (sql.exec('SELECT 1 FROM refund_days WHERE id = ?', o.id).toArray().length) return true;
  sql.exec('DELETE FROM refund_days WHERE day < ?', o.day);
  const used = sql
    .exec<{ n: number }>(
      'SELECT COALESCE(SUM(amount), 0) AS n FROM refund_days WHERE day = ?',
      o.day,
    )
    .one().n;
  if (used + o.amount > o.cap) return false;
  sql.exec('INSERT INTO refund_days (id, day, amount) VALUES (?, ?, ?)', o.id, o.day, o.amount);
  return true;
}
