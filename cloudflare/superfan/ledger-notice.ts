// The findings mailed so far and today's email count: SQL for the ledger's notice methods.
// Each function runs inside the ledger's transaction. A finding is marked only after its email
// is sent, so a lost acknowledgment repeats a digest rather than losing it. Urgent findings have
// their own limit, per signal: the digest's daily cap never holds one, and one flapping signal
// never reaches the inbox more than URGENT_PER_DAY times.

/** The least time between two urgent mails for one signal. */
export const URGENT_GAP_MS = 30 * 60_000;
/** Urgent mails for one signal per UTC day. */
export const URGENT_PER_DAY = 6;

/** Today's unmailed open findings, and one email counted, unless the cap is reached. */
export function claimNotice(sql: SqlStorage, day: string, cap: number, limit: number) {
  const rows = sql
    .exec<Record<string, SqlStorageValue>>(
      "SELECT * FROM findings WHERE status = 'open' AND level = 'digest' AND notified_at IS NULL ORDER BY id LIMIT ?",
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

/** Open urgent findings not mailed yet whose signal may mail now, each with its turn counted
 * (`seq`: this signal's mail number today, which keys the send). The rest wait for a later pass. */
export function claimUrgent(sql: SqlStorage, day: string, now: number, limit: number) {
  const due: (Record<string, SqlStorageValue> & { seq: number })[] = [];
  for (const row of sql
    .exec<Record<string, SqlStorageValue>>(
      "SELECT * FROM findings WHERE status = 'open' AND level = 'urgent' AND notified_at IS NULL ORDER BY id LIMIT ?",
      limit,
    )
    .toArray()) {
    const last = sql
      .exec<{ day: string; sent: number; last_sent: number }>(
        'SELECT day, sent, last_sent FROM urgent_notices WHERE dedup_key = ?',
        row.dedup_key,
      )
      .toArray()[0];
    const sent = last?.day === day ? last.sent : 0;
    if (sent >= URGENT_PER_DAY || (last && now - last.last_sent < URGENT_GAP_MS)) continue;
    sql.exec(
      `INSERT INTO urgent_notices (dedup_key, day, sent, last_sent, previous_sent) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(dedup_key) DO UPDATE SET day = excluded.day, sent = excluded.sent,
         previous_sent = last_sent, last_sent = excluded.last_sent`,
      row.dedup_key,
      day,
      sent + 1,
      now,
    );
    due.push({ ...row, seq: sent + 1 });
  }
  return due;
}

/** Gives back the turns of an urgent mail that was not sent. */
export function releaseUrgent(sql: SqlStorage, keys: string[]) {
  for (const key of keys)
    sql.exec(
      'UPDATE urgent_notices SET sent = MAX(sent - 1, 0), last_sent = previous_sent WHERE dedup_key = ?',
      key,
    );
}

export function markNotified(sql: SqlStorage, ids: number[], now: number) {
  for (const id of ids) sql.exec('UPDATE findings SET notified_at = ? WHERE id = ?', now, id);
}
