// The ledger's entry writes and its two hold sweeps, over the ledger's SQL inside one of its
// transactions: a finished run attempt's unsettled holds (charged whole, since the provider may
// have billed them) and holds nobody settled in time (released).

export interface EntryFields {
  repo: string;
  run: string;
  agent: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_microusd: number;
  note: string;
}

/** Appends one entry; a key already written is left as it was (every write is idempotent). */
export function insertEntry(
  sql: SqlStorage,
  key: string,
  kind: string,
  amount: number,
  extra: Partial<EntryFields> = {},
) {
  sql.exec(
    `INSERT INTO entries (key, at, kind, amount, repo, run, agent, model, input_tokens, output_tokens, cost_microusd, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`,
    key,
    Date.now(),
    kind,
    amount,
    extra.repo ?? null,
    extra.run ?? null,
    extra.agent ?? null,
    extra.model ?? null,
    extra.input_tokens ?? null,
    extra.output_tokens ?? null,
    extra.cost_microusd ?? null,
    extra.note ?? null,
  );
}

const OPEN_HOLD = `h.kind = 'hold' AND NOT EXISTS (SELECT 1 FROM entries r WHERE r.key = 'release:' || substr(h.key, 6))`;
type Hold = {
  key: string;
  amount: number;
  repo: string;
  run: string;
  agent: string;
  model: string;
};

/** A finished run attempt's open holds, each charged whole. */
export function closeRunHolds(sql: SqlStorage, run: string, attempt: number): number {
  const open = sql
    .exec<Hold>(
      `SELECT h.key, h.amount, h.repo, h.run, h.agent, h.model FROM entries h
       WHERE ${OPEN_HOLD} AND h.run = ? AND h.key LIKE ?`,
      run,
      `hold:${run}:${attempt}:%`,
    )
    .toArray();
  for (const h of open) {
    const k = h.key.slice('hold:'.length);
    const meta = { repo: h.repo, run, agent: h.agent, model: h.model };
    insertEntry(sql, `release:${k}`, 'release', -h.amount, meta);
    insertEntry(sql, `charge:${k}`, 'charge', h.amount, {
      ...meta,
      note: 'Call outcome unknown: charged its hold',
    });
  }
  return open.length;
}

/** Open holds taken at or before `before`, released. */
export function releaseStaleHolds(sql: SqlStorage, before: number): number {
  const stale = sql
    .exec<Hold>(
      `SELECT h.key, h.amount, h.repo, h.run, h.agent, h.model FROM entries h WHERE ${OPEN_HOLD} AND h.at <= ?`,
      before,
    )
    .toArray();
  for (const h of stale)
    insertEntry(sql, `release:${h.key.slice('hold:'.length)}`, 'release', -h.amount, {
      repo: h.repo,
      run: h.run,
      agent: h.agent,
      model: h.model,
      note: 'Stale hold released',
    });
  return stale.length;
}
