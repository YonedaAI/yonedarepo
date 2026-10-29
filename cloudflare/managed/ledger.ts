// One account's agent credit, in a SQLite Durable Object (one per billed account). Entries
// are append-only, in micro-USD: a grant adds credit; a model call first holds its worst case,
// then settles with a charge (cost × margin from the provider's reported usage) and a release
// of the hold. The balance is the sum of every entry, so an outstanding hold already counts.
// Each method is one synchronous transaction, so concurrent runs cannot overspend.
import { DurableObject } from 'cloudflare:workers';
import { STARTING_CREDIT_USD } from '../../shared/managed-agents';
import type { ManagedEnv } from './config';
import { LEDGER_SCHEMA, migrate } from './schema';

export const STARTING_CREDIT_MICROUSD = STARTING_CREDIT_USD * 1_000_000;
/** Past the longest run (30 minute timeout, polling and posting), a hold nobody settled is stale. */
export const STALE_HOLD_MS = 2 * 60 * 60_000;

export interface CallMeta {
  repo: string;
  run: string;
  agent: string;
  model: string;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Provider cost at list rates, micro-USD. */
  costMicrousd: number;
  /** What the account pays: ceil(cost × margin), micro-USD. */
  chargeMicrousd: number;
}
export interface Balance {
  granted: number;
  used: number;
  balance: number;
}

export class CreditLedger extends DurableObject<ManagedEnv> {
  constructor(ctx: DurableObjectState, env: ManagedEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => migrate(ctx.storage.sql, LEDGER_SCHEMA));
    });
  }

  #tx<T>(fn: (sql: SqlStorage) => T): T {
    return this.ctx.storage.transactionSync(() => fn(this.ctx.storage.sql));
  }

  #insert(sql: SqlStorage, key: string, kind: string, amount: number, extra: Partial<Row> = {}) {
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

  #balance(sql: SqlStorage): Balance {
    const row = sql
      .exec<{ total: number; granted: number; used: number }>(
        `SELECT COALESCE(SUM(amount), 0) AS total,
                COALESCE(SUM(CASE WHEN kind = 'grant' THEN amount END), 0) AS granted,
                COALESCE(-SUM(CASE WHEN kind = 'charge' THEN amount END), 0) AS used
         FROM entries`,
      )
      .one();
    return { granted: row.granted, used: row.used, balance: row.total };
  }

  /** The promotional starting credit, granted once per account. */
  ensureStartingCredit(): Balance {
    return this.#tx((sql) => {
      this.#insert(sql, 'grant:starting-credit', 'grant', STARTING_CREDIT_MICROUSD, {
        note: 'Starting credit',
      });
      return this.#balance(sql);
    });
  }

  balance(): Balance {
    return this.#balance(this.ctx.storage.sql);
  }

  /** Holds `amount` for one call unless the balance cannot cover it (then nothing is held). */
  async hold(
    key: string,
    amount: number,
    meta: CallMeta,
  ): Promise<{ held: boolean; balance: number }> {
    const answer = this.#tx((sql) => {
      const existing = sql.exec('SELECT 1 FROM entries WHERE key = ?', `hold:${key}`).toArray();
      if (existing.length) return { held: true, balance: this.#balance(sql).balance };
      const { balance } = this.#balance(sql);
      if (balance <= 0 || balance < amount) return { held: false, balance };
      this.#insert(sql, `hold:${key}`, 'hold', -amount, meta);
      return { held: true, balance: balance - amount };
    });
    if (answer.held && (await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + STALE_HOLD_MS);
    return answer;
  }

  /** Holds nobody settled within STALE_HOLD_MS (an isolate lost mid-call, a run that never
   * closed) are released, so a lost request cannot keep credit locked. */
  releaseStale(now = Date.now()): number {
    const released = this.#tx((sql) => {
      const stale = sql
        .exec<{
          key: string;
          amount: number;
          repo: string;
          run: string;
          agent: string;
          model: string;
        }>(
          `SELECT h.key, h.amount, h.repo, h.run, h.agent, h.model FROM entries h
           WHERE h.kind = 'hold' AND h.at <= ?
             AND NOT EXISTS (SELECT 1 FROM entries r WHERE r.key = 'release:' || substr(h.key, 6))`,
          now - STALE_HOLD_MS,
        )
        .toArray();
      for (const h of stale)
        this.#insert(sql, `release:${h.key.slice('hold:'.length)}`, 'release', -h.amount, {
          repo: h.repo,
          run: h.run,
          agent: h.agent,
          model: h.model,
          note: 'Stale hold released',
        });
      return stale.length;
    });
    return released;
  }

  override async alarm() {
    this.releaseStale();
    const open = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM entries h WHERE h.kind = 'hold'
           AND NOT EXISTS (SELECT 1 FROM entries r WHERE r.key = 'release:' || substr(h.key, 6))`,
      )
      .one().n;
    if (open > 0) await this.ctx.storage.setAlarm(Date.now() + STALE_HOLD_MS);
  }

  /**
   * Settles a hold: `usage` charges what the provider reported; null with `sent` charges the
   * whole hold (the call may have been billed); null unsent just releases it. Idempotent.
   */
  settle(key: string, usage: Usage | null, sent: boolean, meta: CallMeta) {
    this.#tx((sql) => {
      const hold = sql
        .exec<{ amount: number }>(
          "SELECT amount FROM entries WHERE key = ? AND kind = 'hold'",
          `hold:${key}`,
        )
        .toArray()[0];
      if (!hold) return;
      this.#insert(sql, `release:${key}`, 'release', -hold.amount, meta);
      if (usage)
        this.#insert(sql, `charge:${key}`, 'charge', -usage.chargeMicrousd, {
          ...meta,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cost_microusd: usage.costMicrousd,
        });
      else if (sent)
        this.#insert(sql, `charge:${key}`, 'charge', hold.amount, {
          ...meta,
          note: 'Call outcome unknown: charged its hold',
        });
    });
  }

  /** A charge with no hold (a run's container time), once per key. */
  charge(key: string, amount: number, meta: CallMeta, note: string) {
    if (!Number.isSafeInteger(amount) || amount <= 0) return;
    this.#tx((sql) => this.#insert(sql, `charge:${key}`, 'charge', -amount, { ...meta, note }));
  }

  /**
   * Closes a finished run attempt's holds that never settled (a stream cut off, an isolate
   * lost mid-call): each is charged whole, since the provider may have billed it.
   */
  closeRun(run: string, attempt: number): number {
    return this.#tx((sql) => {
      const open = sql
        .exec<{ key: string; amount: number; repo: string; agent: string; model: string }>(
          `SELECT h.key, h.amount, h.repo, h.agent, h.model FROM entries h
           WHERE h.kind = 'hold' AND h.run = ? AND h.key LIKE ?
             AND NOT EXISTS (SELECT 1 FROM entries r WHERE r.key = 'release:' || substr(h.key, 6))`,
          run,
          `hold:${run}:${attempt}:%`,
        )
        .toArray();
      for (const h of open) {
        const k = h.key.slice('hold:'.length);
        const meta = { repo: h.repo, run, agent: h.agent, model: h.model };
        this.#insert(sql, `release:${k}`, 'release', -h.amount, meta);
        this.#insert(sql, `charge:${k}`, 'charge', h.amount, {
          ...meta,
          note: 'Call outcome unknown: charged its hold',
        });
      }
      return open.length;
    });
  }

  /** A run's entries, oldest first (its cost breakdown). */
  runEntries(run: string) {
    return this.ctx.storage.sql
      .exec(
        "SELECT kind, amount, model, input_tokens, output_tokens, cost_microusd, note, at FROM entries WHERE run = ? AND kind = 'charge' ORDER BY id",
        run,
      )
      .toArray();
  }

  /** Adds credit and hands back the runs that were waiting for it (now forgotten here). */
  grant(key: string, amount: number, note: string): { balance: Balance; resume: Paused[] } {
    return this.#tx((sql) => {
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid grant');
      this.#insert(sql, `grant:${key}`, 'grant', amount, { note });
      const balance = this.#balance(sql);
      if (balance.balance <= 0) return { balance, resume: [] };
      const resume = sql.exec<Paused>('SELECT repo, run FROM paused ORDER BY at').toArray();
      sql.exec('DELETE FROM paused');
      return { balance, resume };
    });
  }

  /** Records a run that stopped for credit, to resume when credit is granted. */
  pause(repo: string, run: string) {
    this.ctx.storage.sql.exec(
      'INSERT INTO paused (repo, run, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      repo,
      run,
      Date.now(),
    );
  }

  entries(limit: number) {
    return this.ctx.storage.sql
      .exec('SELECT * FROM entries ORDER BY id DESC LIMIT ?', Math.min(Math.max(limit, 1), 500))
      .toArray();
  }
}

type Row = {
  repo: string;
  run: string;
  agent: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_microusd: number;
  note: string;
};
export type Paused = { repo: string; run: string };

export const ledgerStub = (env: ManagedEnv, account: string) =>
  env.LEDGER.get(env.LEDGER.idFromName(account));
