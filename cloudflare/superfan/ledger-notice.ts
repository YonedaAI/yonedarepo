// The findings mailed so far and today's email count: SQL for the ledger's notice methods.
// Each function runs inside the ledger's transaction. A finding is marked only after its email
// is sent, so a lost acknowledgment repeats a digest rather than losing it.

/** Today's unmailed open findings, and one email counted, unless the cap is reached. */
export function claimNotice(sql: SqlStorage, day: string, cap: number, limit: number) {
  const rows = sql
    .exec<Record<string, SqlStorageValue>>(
      "SELECT * FROM findings WHERE status = 'open' AND notified_at IS NULL ORDER BY id LIMIT ?",
      limit,
    )
    .toArray();
  if (!rows.length) return [];
  sql.exec('INSERT OR IGNORE INTO spend_days (day) VALUES (?)', day);
  const { emails } = sql
    .exec<{ emails: number }>('SELECT emails FROM spend_days WHERE day = ?', day)
    .one();
  if (emails >= cap) return [];
  sql.exec('UPDATE spend_days SET emails = emails + 1 WHERE day = ?', day);
  return rows;
}

/** Gives back the email of a digest that was not sent. */
export function releaseNotice(sql: SqlStorage, day: string) {
  sql.exec('UPDATE spend_days SET emails = MAX(emails - 1, 0) WHERE day = ?', day);
}

export function markNotified(sql: SqlStorage, ids: number[], now: number) {
  for (const id of ids) sql.exec('UPDATE findings SET notified_at = ? WHERE id = ?', now, id);
}
