// The revenue rollup, from the ledger's side. Triggers (schema v5) mark a day in the transaction
// that changes it; the alarm reads each marked day back whole and pushes it to this Worker's D1,
// outside any transaction, with the account's position now. Whole rows make every push idempotent and a
// rebuild the same operation, and `version` keeps a late retry from overwriting newer numbers.
// Nothing here is authoritative: D1 can be emptied and pushed again.
//
// Only what the ledger recorded is split out. A model call settled with the provider's usage has
// a cost; container time and a call whose outcome is unknown were charged but have none, and
// they stay apart rather than being given an estimate.
import { balanceOf } from './ledger-holds';
import { unspentByTopUp } from './ledger-refunds';

/** How many days one alarm pushes: a long history goes in several. */
export const ROLLUP_BATCH_DAYS = 31;
const DAY_MS = 86_400_000;
/** The key `run.ts` gives a run's container time. */
const CONTAINER = 'charge:container:%';

export type RollupDay = {
  day: string;
  top_ups: number;
  refunds: number;
  disputes_lost: number;
  free_granted: number;
  model_charged: number;
  model_cost: number;
  container_charged: number;
  unpriced_charged: number;
};
export type RollupAccount = {
  first_paid_day: string | null;
  sold_outstanding: number;
  free_outstanding: number;
  frozen: number;
  refunds_open: number;
};
type Mark = { day: string; mark: number };
export type RollupBatch = {
  account: string;
  version: number;
  marks: Mark[];
  days: RollupDay[];
  now: RollupAccount;
};

export const rollupPending = (sql: SqlStorage) =>
  sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM rollup_dirty').one().n;

export function rememberAccount(sql: SqlStorage, account: string) {
  sql.exec(
    `INSERT INTO rollup_state (id, account) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET account = excluded.account`,
    account,
  );
}

/** A day's sums from the entries, refunds and disputes that landed on it. */
function dayRow(sql: SqlStorage, day: string): RollupDay {
  const from = Date.parse(`${day}T00:00:00Z`);
  const to = from + DAY_MS;
  const entries = sql
    .exec<Omit<RollupDay, 'day' | 'refunds' | 'disputes_lost'>>(
      `SELECT
         COALESCE(SUM(CASE WHEN key LIKE 'grant:topup:%' THEN amount END), 0) AS top_ups,
         COALESCE(SUM(CASE WHEN key LIKE 'grant:%' AND key NOT LIKE 'grant:topup:%'
                           THEN amount END), 0) AS free_granted,
         COALESCE(-SUM(CASE WHEN kind = 'charge' AND cost_microusd IS NOT NULL
                            THEN amount END), 0) AS model_charged,
         COALESCE(SUM(CASE WHEN kind = 'charge' THEN cost_microusd END), 0) AS model_cost,
         COALESCE(-SUM(CASE WHEN kind = 'charge' AND cost_microusd IS NULL AND key LIKE ?1
                            THEN amount END), 0) AS container_charged,
         COALESCE(-SUM(CASE WHEN kind = 'charge' AND cost_microusd IS NULL AND key NOT LIKE ?1
                            THEN amount END), 0) AS unpriced_charged
       FROM entries WHERE at >= ?2 AND at < ?3`,
      CONTAINER,
      from,
      to,
    )
    .one();
  const sum = (query: string) => sql.exec<{ n: number }>(query, from, to).one().n;
  return {
    day,
    ...entries,
    refunds: sum(
      `SELECT COALESCE(SUM(amount), 0) AS n FROM refunds
       WHERE status = 'succeeded' AND settled_at >= ? AND settled_at < ?`,
    ),
    // The money the dispute took, which can be more than the credit it could freeze.
    disputes_lost: sum(
      `SELECT COALESCE(SUM(amount), 0) AS n FROM disputes
       WHERE status = 'lost' AND closed_at >= ? AND closed_at < ?`,
    ),
  };
}

/** The account now. Sold credit is what the balance holds of top-ups under the ledger's rule
 * (oldest spent first); the rest of a positive balance was given away, not sold. */
function accountRow(sql: SqlStorage): RollupAccount {
  const balance = Math.max(0, balanceOf(sql).balance);
  const sold = [...unspentByTopUp(sql).values()].reduce((sum, n) => sum + n, 0);
  const paid = sql
    .exec<{ at: number | null }>("SELECT MIN(at) AS at FROM entries WHERE key LIKE 'grant:topup:%'")
    .one().at;
  const one = (query: string) => sql.exec<{ n: number }>(query).one().n;
  return {
    first_paid_day: paid === null ? null : new Date(paid).toISOString().slice(0, 10),
    sold_outstanding: sold,
    free_outstanding: balance - sold,
    frozen: one("SELECT COALESCE(SUM(frozen), 0) AS n FROM disputes WHERE status = 'open'"),
    refunds_open: one("SELECT COALESCE(SUM(amount), 0) AS n FROM refunds WHERE status = 'open'"),
  };
}

/** The next days to push, under a new version, or null. Their marks stay until D1 has them. */
export function rollupBatch(sql: SqlStorage, limit: number): RollupBatch | null {
  const state = sql
    .exec<{ account: string; version: number }>(
      'SELECT account, version FROM rollup_state WHERE id = 1',
    )
    .toArray()[0];
  const marks = sql.exec<Mark>('SELECT day, mark FROM rollup_dirty ORDER BY day LIMIT ?', limit);
  const list = marks.toArray();
  if (!state || !list.length) return null;
  const version = state.version + 1;
  sql.exec('UPDATE rollup_state SET version = ?', version);
  return {
    account: state.account,
    version,
    marks: list,
    days: list.map((m) => dayRow(sql, m.day)),
    now: accountRow(sql),
  };
}

/** D1 has `marks`. A day marked again since then stays, for the next push. */
export function rollupDone(sql: SqlStorage, marks: Mark[]) {
  for (const { day, mark } of marks)
    sql.exec('DELETE FROM rollup_dirty WHERE day = ? AND mark = ?', day, mark);
}

/** Every day the ledger has anything on. */
export function markAllDays(sql: SqlStorage) {
  const day = (column: string) => `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch')`;
  sql.exec(
    `INSERT INTO rollup_dirty (day, mark)
     SELECT ${day('at')}, 1 FROM entries
     UNION SELECT ${day('settled_at')}, 1 FROM refunds WHERE settled_at IS NOT NULL
     UNION SELECT ${day('closed_at')}, 1 FROM disputes WHERE closed_at IS NOT NULL
     ON CONFLICT(day) DO UPDATE SET mark = mark + 1`,
  );
}

const DAY_COLUMNS = [
  'top_ups',
  'refunds',
  'disputes_lost',
  'free_granted',
  'model_charged',
  'model_cost',
  'container_charged',
  'unpriced_charged',
] as const;
const ACCOUNT_COLUMNS = [
  'first_paid_day',
  'sold_outstanding',
  'free_outstanding',
  'frozen',
  'refunds_open',
] as const;

const updates = (columns: readonly string[]) =>
  columns.map((c) => `${c} = excluded.${c}`).join(', ');

/** Whole rows, each kept only if it is newer than what D1 has. */
export function rollupStatements(db: D1Database, batch: RollupBatch) {
  const { account, version, days, now } = batch;
  const dayQuery = db.prepare(
    `INSERT INTO billing_daily (account, day, version, ${DAY_COLUMNS.join(', ')})
     VALUES (?, ?, ?, ${DAY_COLUMNS.map(() => '?').join(', ')})
     ON CONFLICT(account, day) DO UPDATE SET version = excluded.version, ${updates(DAY_COLUMNS)}
     WHERE excluded.version >= billing_daily.version`,
  );
  const accountQuery = db.prepare(
    `INSERT INTO billing_accounts (account, version, updated_at, ${ACCOUNT_COLUMNS.join(', ')})
     VALUES (?, ?, ?, ${ACCOUNT_COLUMNS.map(() => '?').join(', ')})
     ON CONFLICT(account) DO UPDATE SET version = excluded.version,
       updated_at = excluded.updated_at, ${updates(ACCOUNT_COLUMNS)}
     WHERE excluded.version >= billing_accounts.version`,
  );
  return [
    ...days.map((d) => dayQuery.bind(account, d.day, version, ...DAY_COLUMNS.map((c) => d[c]))),
    accountQuery.bind(account, version, Date.now(), ...ACCOUNT_COLUMNS.map((c) => now[c])),
  ];
}
