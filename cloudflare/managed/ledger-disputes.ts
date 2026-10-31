// Disputes inside a CreditLedger, over its SQL and each called in one of its transactions. An
// open dispute freezes what is left of its credit (spent credit cannot be frozen) and stops the
// card being charged (topUpDue asks), without touching the customer's own auto top-up switch.
// Closed, the credit comes back, unless the dispute was lost: then it stays gone, with the money.
// Keyed by the dispute: Stripe's events can repeat and arrive in either order.
import { insertEntry } from './ledger-holds';
import { unspentByTopUp } from './ledger-refunds';

export type DisputeRow = {
  id: string;
  top_up: string | null;
  charge: string;
  amount: number;
  frozen: number;
  status: string;
  reason: string | null;
  opened_at: number;
  closed_at: number | null;
};

export const disputeRows = (sql: SqlStorage, limit = 50) =>
  sql.exec<DisputeRow>('SELECT * FROM disputes ORDER BY opened_at DESC LIMIT ?', limit).toArray();

export type DisputeEvent = {
  id: string;
  top_up: string;
  charge: string;
  amount: number;
  reason: string | null;
};

const disputeRow = (sql: SqlStorage, id: string) =>
  sql.exec<DisputeRow>('SELECT * FROM disputes WHERE id = ?', id).toArray()[0] ?? null;

function record(sql: SqlStorage, d: DisputeEvent, frozen: number, status: string, now: number) {
  sql.exec(
    `INSERT INTO disputes (id, top_up, charge, amount, frozen, status, reason, opened_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    d.id,
    d.top_up,
    d.charge,
    d.amount,
    frozen,
    status,
    d.reason,
    now,
    status === 'open' ? null : now,
  );
}

export function openDispute(sql: SqlStorage, d: DisputeEvent, now: number) {
  if (disputeRow(sql, d.id)) return;
  const frozen = Math.min(d.amount, unspentByTopUp(sql).get(d.top_up) ?? 0);
  record(sql, d, frozen, 'open', now);
  if (frozen > 0)
    insertEntry(sql, `freeze:${d.id}`, 'grant', -frozen, { note: `Dispute on ${d.top_up}` });
}

/** `status` is Stripe's: `lost`, or a way of closing that leaves the money here. */
export function closeDispute(sql: SqlStorage, d: DisputeEvent, status: string, now: number) {
  const row = disputeRow(sql, d.id);
  if (!row) record(sql, d, 0, status, now);
  if (row?.status !== 'open') return;
  sql.exec(
    'UPDATE disputes SET status = ?, closed_at = ? WHERE id = ?',
    status.slice(0, 40),
    now,
    d.id,
  );
  if (status !== 'lost' && row.frozen > 0)
    insertEntry(sql, `unfreeze:${d.id}`, 'grant', row.frozen, { note: `Dispute ${status}` });
}
