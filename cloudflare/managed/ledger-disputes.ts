// Disputes inside a CreditLedger, over its SQL and each called in one of its transactions.

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
