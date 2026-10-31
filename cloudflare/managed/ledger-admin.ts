// The base of the ledger Durable Object: its schema and transaction, and what operators read
// and do to a ledger (admin-billing.ts and admin-refund.ts call these). Thin methods over the
// SQL in ledger-refunds.ts, ledger-disputes.ts and ledger-pages.ts; CreditLedger adds credit.
import { DurableObject } from 'cloudflare:workers';
import type { ManagedEnv } from './config';
import { billingRow, cardOf } from './ledger-billing';
import { disputeRows } from './ledger-disputes';
import { balanceOf } from './ledger-holds';
import { entriesPage, usagePage } from './ledger-pages';
import {
  type RefundAsk,
  refundAccepted,
  refundFailed,
  refundIntent,
  refundRow,
  refundRows,
  refundSucceeded,
  reserveRefund,
  takenBack,
  topUpRows,
  unspentByTopUp,
} from './ledger-refunds';
import { LEDGER_SCHEMA, migrate } from './schema';

/** How soon an open refund is tried again: the alarm queues it, until it settles. */
export const REFUND_RETRY_MS = 5 * 60_000;

export type Paused = { repo: string; run: string };

export class LedgerAdmin extends DurableObject<ManagedEnv> {
  constructor(ctx: DurableObjectState, env: ManagedEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => migrate(ctx.storage.sql, LEDGER_SCHEMA));
    });
  }

  protected tx<T>(fn: (sql: SqlStorage) => T): T {
    return this.ctx.storage.transactionSync(() => fn(this.ctx.storage.sql));
  }

  /** The account as operators see it, in micro-USD (never the payment method id). */
  adminState() {
    return this.tx((sql) => {
      const row = billingRow(sql);
      const back = takenBack(sql);
      const unspent = unspentByTopUp(sql);
      return {
        balance: balanceOf(sql),
        customer: row.customer,
        card: cardOf(row),
        auto_top_up: row.auto_top_up !== 0,
        top_up_failed: row.top_up_failed,
        paused:
          row.paused_at === null
            ? null
            : { at: row.paused_at, reason: row.paused_reason, by: row.paused_by },
        top_ups: topUpRows(sql).map((t) => ({
          ...t,
          refunded: back.get(t.key)?.refunded ?? 0,
          frozen: back.get(t.key)?.frozen ?? 0,
          unspent: unspent.get(t.key) ?? 0,
        })),
        refunds: refundRows(sql),
        disputes: disputeRows(sql),
      };
    });
  }

  ledgerPage(before: number | null, limit: number) {
    return entriesPage(this.ctx.storage.sql, before, limit);
  }

  usagePage(before: number | null, limit: number) {
    return usagePage(this.ctx.storage.sql, before, limit);
  }

  /** Records a refund and takes its credit. The alarm is set in the same breath (no await in
   * between, so it commits with the record): a Worker lost from here on is retried. */
  async refundIntent(ask: RefundAsk) {
    const answer = this.tx((sql) => refundIntent(sql, ask, Date.now()));
    if (answer.ok && !answer.replay) await this.ctx.storage.setAlarm(Date.now() + REFUND_RETRY_MS);
    return answer;
  }

  /** A refund with the payment intent it is against. */
  refund(id: string) {
    const sql = this.ctx.storage.sql;
    const row = refundRow(sql, id);
    if (!row) return null;
    const topUp = sql
      .exec<{ payment_intent: string | null }>(
        'SELECT payment_intent FROM top_ups WHERE key = ?',
        row.top_up,
      )
      .toArray()[0];
    return { ...row, payment_intent: topUp?.payment_intent ?? null };
  }

  refundAccepted(id: string, stripeRefund: string) {
    this.tx((sql) => refundAccepted(sql, id, stripeRefund));
  }

  refundSucceeded(id: string, stripeRefund: string) {
    this.tx((sql) => refundSucceeded(sql, id, stripeRefund, Date.now()));
  }

  /** Answers the runs its credit coming back lets go on. */
  refundFailed(id: string, error: string) {
    return this.tx((sql) => {
      refundFailed(sql, id, error, Date.now());
      return { resume: this.takePaused(sql) };
    });
  }

  /** Runs that waited for credit, handed back once there is some (now forgotten here). */
  protected takePaused(sql: SqlStorage): Paused[] {
    if (balanceOf(sql).balance <= 0) return [];
    const resume = sql.exec<Paused>('SELECT repo, run FROM paused ORDER BY at').toArray();
    sql.exec('DELETE FROM paused');
    return resume;
  }

  /** The daily limit, on the limits instance: false when `amount` does not fit under `cap`. */
  reserveRefund(id: string, amount: number, cap: number, day: string) {
    return this.tx((sql) => reserveRefund(sql, { id, amount, cap, day }));
  }

  releaseRefund(id: string) {
    this.ctx.storage.sql.exec('DELETE FROM refund_days WHERE id = ?', id);
  }

  /** What was reserved of the daily limit on `day` (the limits instance, admin-refund.ts). */
  refundedOn(day: string): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>(
        'SELECT COALESCE(SUM(amount), 0) AS n FROM refund_days WHERE day = ?',
        day,
      )
      .one().n;
  }
}
