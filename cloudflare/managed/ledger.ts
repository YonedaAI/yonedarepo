// One account's agent credit, in a SQLite Durable Object (one per billed account). Entries
// are append-only, in micro-USD: a grant adds credit; a model call first holds its worst case,
// then settles with a charge (cost × margin from the provider's reported usage) and a release
// of the hold. The balance is the sum of every entry, so an outstanding hold already counts.
// Each method is one synchronous transaction, so concurrent runs cannot overspend. What
// operators do to a ledger is in LedgerAdmin, which this class extends.
import { STARTING_CREDIT_USD } from '../../shared/managed-agents';
import type { ManagedEnv, QueueMessage } from './config';
import {
  LedgerAdmin,
  type Paused,
  REFUND_RETRY_MS,
  ROLLUP_DELAY_MS,
  ROLLUP_RETRY_MS,
} from './ledger-admin';
import {
  billingRow,
  cardOf,
  closeBilling,
  forgetCard,
  type PendingTopUp,
  recordCard,
  setAutoTopUp,
  setCustomer,
  settleTopUp,
  topUp,
  topUpDue,
  topUps,
} from './ledger-billing';
import {
  type Balance,
  balanceOf,
  closeRunHolds,
  insertEntry,
  releaseStaleHolds,
} from './ledger-holds';

import { openRefunds } from './ledger-refunds';

export type { Paused } from './ledger-admin';
export type { Balance } from './ledger-holds';

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
export class CreditLedger extends LedgerAdmin {
  #insert(sql: SqlStorage, key: string, kind: string, amount: number, extra: Partial<Row> = {}) {
    insertEntry(sql, key, kind, amount, extra);
  }

  /** The promotional starting credit, granted once per account. */
  ensureStartingCredit(): Balance {
    return this.tx((sql) => {
      this.#insert(sql, 'grant:starting-credit', 'grant', STARTING_CREDIT_MICROUSD, {
        note: 'Starting credit',
      });
      return balanceOf(sql);
    });
  }

  balance(): Balance {
    return balanceOf(this.ctx.storage.sql);
  }

  /** Holds `amount` for one call unless the balance cannot cover it (then nothing is held). */
  async hold(
    key: string,
    amount: number,
    meta: CallMeta,
  ): Promise<{ held: boolean; balance: number }> {
    const answer = this.tx((sql) => {
      const existing = sql.exec('SELECT 1 FROM entries WHERE key = ?', `hold:${key}`).toArray();
      if (existing.length) return { held: true, balance: balanceOf(sql).balance };
      const { balance } = balanceOf(sql);
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
    return this.tx((sql) => releaseStaleHolds(sql, now - STALE_HOLD_MS));
  }

  /** When the refunds were last queued: an alarm that came for the rollup need not resend them. */
  #refundsSent = 0;

  /** One alarm serves all of it: stale holds, the rollup and open refunds. What comes next is
   * decided last, with no await after it, so a write made meanwhile is not pushed back. */
  override async alarm() {
    this.rollupArmed = false;
    this.releaseStale();
    const failed = await this.pushRollup();
    const refunds = openRefunds(this.ctx.storage.sql);
    if (refunds.length && Date.now() - this.#refundsSent >= REFUND_RETRY_MS) {
      this.#refundsSent = Date.now();
      await this.env.RUNS.sendBatch(
        refunds.map((r) => ({
          body: { kind: 'refund', account: r.account, id: r.id } as QueueMessage,
        })),
      );
    }
    const open = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM entries h WHERE h.kind = 'hold'
           AND NOT EXISTS (SELECT 1 FROM entries r WHERE r.key = 'release:' || substr(h.key, 6))`,
      )
      .one().n;
    const rollup = this.rollupWaiting();
    if (rollup) this.rollupArmed = true;
    const wait = rollup
      ? failed
        ? ROLLUP_RETRY_MS
        : ROLLUP_DELAY_MS
      : refunds.length
        ? REFUND_RETRY_MS
        : open > 0
          ? STALE_HOLD_MS
          : null;
    if (wait !== null) await this.ctx.storage.setAlarm(Date.now() + wait);
  }

  /**
   * Settles a hold: `usage` charges what the provider reported; null with `sent` charges the
   * whole hold (the call may have been billed); null unsent just releases it. Idempotent.
   */
  settle(key: string, usage: Usage | null, sent: boolean, meta: CallMeta): string | null {
    return this.tx((sql) => {
      const hold = sql
        .exec<{ amount: number }>(
          "SELECT amount FROM entries WHERE key = ? AND kind = 'hold'",
          `hold:${key}`,
        )
        .toArray()[0];
      if (!hold) return null;
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
      return topUpDue(sql, balanceOf(sql).balance, Date.now());
    });
  }

  /** A charge with no hold (a run's container time), once per key. */
  /** Answers the top-up the charge now calls for (its key), or null. */
  charge(key: string, amount: number, meta: CallMeta, note: string): string | null {
    if (!Number.isSafeInteger(amount) || amount <= 0) return null;
    return this.tx((sql) => {
      this.#insert(sql, `charge:${key}`, 'charge', -amount, { ...meta, note });
      return topUpDue(sql, balanceOf(sql).balance, Date.now());
    });
  }

  /**
   * Closes a finished run attempt's holds that never settled (a stream cut off, an isolate
   * lost mid-call): each is charged whole, since the provider may have billed it.
   */
  closeRun(run: string, attempt: number): number {
    return this.tx((sql) => closeRunHolds(sql, run, attempt));
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

  /** The workspace's billing as the API shows it (never the payment method id). */
  billing() {
    const sql = this.ctx.storage.sql;
    const row = billingRow(sql);
    const promo =
      sql.exec("SELECT 1 FROM entries WHERE key = 'grant:card-promo'").toArray().length > 0;
    return {
      customer: row.customer,
      card: cardOf(row),
      top_up_failed: row.top_up_failed,
      auto_top_up: row.auto_top_up !== 0,
      promo_granted: promo,
      top_ups: topUps(sql),
    };
  }

  setCustomer(customer: string) {
    this.tx((sql) => setCustomer(sql, customer));
  }

  setAutoTopUp(enabled: boolean) {
    this.tx((sql) => setAutoTopUp(sql, enabled));
  }

  /** A card saved at Stripe for `customer` (refused for another): recorded, the promotional
   * credit granted once, and runs waiting for credit handed back. */
  addCard(
    customer: string,
    card: { payment_method: string; brand: string; last4: string },
    promoMicrousd: number,
  ): { recorded: boolean; resume: Paused[] } {
    return this.tx((sql) => {
      if (billingRow(sql).customer !== customer) return { recorded: false, resume: [] };
      recordCard(sql, card, Date.now());
      if (promoMicrousd > 0)
        this.#insert(sql, 'grant:card-promo', 'grant', promoMicrousd, {
          note: 'Promotional credit (card on file)',
        });
      return { recorded: true, resume: this.takePaused(sql) };
    });
  }

  removeCard(): string | null {
    return this.tx((sql) => {
      const pm = billingRow(sql).payment_method;
      forgetCard(sql);
      return pm;
    });
  }

  /** A deleted account (`closeBilling`). */
  closeAccount() {
    return this.tx(closeBilling);
  }

  pendingTopUp(key: string): PendingTopUp | null {
    return topUp(this.ctx.storage.sql, key);
  }

  /** A top-up's outcome: on success its credit is granted once (and waiting runs handed back). */
  topUpResult(
    key: string,
    outcome: { ok: true; intent: string } | { ok: false; error: string },
  ): { resume: Paused[] } {
    return this.tx((sql) => {
      const amount = settleTopUp(sql, key, outcome, Date.now());
      if (amount === null) return { resume: [] };
      this.#insert(sql, `grant:topup:${key}`, 'grant', amount, { note: 'Automatic top-up' });
      return { resume: this.takePaused(sql) };
    });
  }

  /** Adds credit and hands back the runs that were waiting for it (now forgotten here). */
  grant(key: string, amount: number, note: string): { balance: Balance; resume: Paused[] } {
    return this.tx((sql) => {
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid grant');
      this.#insert(sql, `grant:${key}`, 'grant', amount, { note });
      const balance = balanceOf(sql);
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

export const ledgerStub = (env: ManagedEnv, account: string) =>
  env.LEDGER.get(env.LEDGER.idFromName(account));
