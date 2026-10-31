// What operators read of a ledger, over its SQL: the entries and the usage per agent run, each
// newest first and paged by entry id (never by time: two entries can share a millisecond).
import type { AdminLedgerEntry, AdminRunUsage, Paged } from '../../shared/admin-billing';

const NAMED = ['refund-reversal', 'refund', 'unfreeze', 'freeze'] as const;

/** An entry's kind as an operator reads it: what takes credit back is stored as a grant. */
function kindOf(key: string, kind: string) {
  return NAMED.find((name) => key.startsWith(`${name}:`)) ?? kind;
}

function paged<T>(rows: T[], limit: number, cursor: (row: T) => number): Paged<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, next: rows.length > limit && last ? cursor(last) : null };
}

export function entriesPage(
  sql: SqlStorage,
  before: number | null,
  limit: number,
): Paged<AdminLedgerEntry> {
  const rows = sql
    .exec<{
      id: number;
      key: string;
      at: number;
      kind: string;
      amount: number;
      repo: string | null;
      run: string | null;
      agent: string | null;
      model: string | null;
      note: string | null;
    }>(
      `SELECT id, key, at, kind, amount, repo, run, agent, model, note FROM entries
       WHERE id < ? ORDER BY id DESC LIMIT ?`,
      before ?? Number.MAX_SAFE_INTEGER,
      limit + 1,
    )
    .toArray()
    .map(({ key, kind, amount, ...row }) => ({
      ...row,
      kind: kindOf(key, kind),
      amount_usd: amount / 1_000_000,
    }));
  return paged(rows, limit, (row) => row.id);
}

export function usagePage(
  sql: SqlStorage,
  before: number | null,
  limit: number,
): Paged<AdminRunUsage> {
  const rows = sql
    .exec<{
      run: string;
      repo: string | null;
      agent: string | null;
      last: number;
      at: number;
      calls: number;
      charged: number;
      input_tokens: number;
      output_tokens: number;
    }>(
      `SELECT run, repo, agent, MAX(id) AS last, MAX(at) AS at, COUNT(*) AS calls,
              -SUM(amount) AS charged, COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM entries WHERE kind = 'charge' AND run IS NOT NULL
       GROUP BY run HAVING last < ? ORDER BY last DESC LIMIT ?`,
      before ?? Number.MAX_SAFE_INTEGER,
      limit + 1,
    )
    .toArray();
  const page = paged(rows, limit, (row) => row.last);
  return {
    next: page.next,
    items: page.items.map(({ last: _, charged, ...row }) => ({
      ...row,
      charged_usd: charged / 1_000_000,
    })),
  };
}
