// The daily spend counter: SQL for the ledger's reservation methods, each run inside the
// ledger's transaction.

export function reserveSpend(sql: SqlStorage, day: string, amount: number, cap: number) {
  sql.exec('INSERT OR IGNORE INTO spend_days (day) VALUES (?)', day);
  const spent = sql
    .exec<{ total: number }>(
      'SELECT reserved + settled AS total FROM spend_days WHERE day = ?',
      day,
    )
    .one().total;
  if (amount <= 0 || spent + amount > cap) {
    sql.exec('UPDATE spend_days SET refused = refused + 1 WHERE day = ?', day);
    return null;
  }
  const id = crypto.randomUUID();
  sql.exec('INSERT INTO reservations (id, day, amount) VALUES (?, ?, ?)', id, day, amount);
  sql.exec(
    'UPDATE spend_days SET reserved = reserved + ?, calls = calls + 1 WHERE day = ?',
    amount,
    day,
  );
  return id;
}

export function settleSpend(sql: SqlStorage, id: string, actual: number) {
  const row = sql
    .exec<{ day: string; amount: number }>(
      'SELECT day, amount FROM reservations WHERE id = ? AND settled IS NULL',
      id,
    )
    .toArray()[0];
  if (!row) return;
  sql.exec('UPDATE reservations SET settled = ? WHERE id = ?', actual, id);
  sql.exec(
    'UPDATE spend_days SET reserved = reserved - ?, settled = settled + ? WHERE day = ?',
    row.amount,
    actual,
    row.day,
  );
}

export function spendToday(sql: SqlStorage, day: string) {
  return (
    sql
      .exec(
        'SELECT day, reserved, settled, calls, refused, emails FROM spend_days WHERE day = ?',
        day,
      )
      .toArray()[0] ?? { day, reserved: 0, settled: 0, calls: 0, refused: 0, emails: 0 }
  );
}
