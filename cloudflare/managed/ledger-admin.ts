// The base of the ledger Durable Object: its schema and transaction, and what operators read
// and do to a ledger (admin-billing.ts and admin-refund.ts call these). Thin methods over the
// SQL in ledger-refunds.ts, ledger-disputes.ts and ledger-pages.ts; CreditLedger adds credit.
import { DurableObject } from 'cloudflare:workers';
import { isCanonicalAccountIdentifier } from '../../shared/account';
import type { ManagedEnv } from './config';
import { billingRow, cancelTopUp, cardOf, setBillingPaused } from './ledger-billing';
import { closeDispute, type DisputeEvent, disputeRows, openDispute } from './ledger-disputes';
import { balanceOf } from './ledger-holds';
import { entriesPage, usagePage } from './ledger-pages';
import {
  type RefundAsk,
  reconcileRows,
  refundAccepted,
  refundFailed,
  refundIntent,
  refundRow,
  refundRows,
  refundSucceeded,
  reserveRefund,
  stripeRefunded,
  takenBack,
  topUpRows,
  unspentByTopUp,
} from './ledger-refunds';
import {
  markAllDays,
  ROLLUP_BATCH_DAYS,
  rememberAccount,
  rollupBatch,
  rollupDone,
  rollupPending,
  rollupStatements,
} from './ledger-rollup';
import { LEDGER_SCHEMA, migrate } from './schema';

/** How soon an open refund is tried again: the alarm queues it, until it settles. */
export const REFUND_RETRY_MS = 5 * 60_000;
/** How long writes gather before they go to the rollup, and the wait after D1 failed. */
export const ROLLUP_DELAY_MS = 5_000;
export const ROLLUP_RETRY_MS = 60_000;

export type Paused = { repo: string; run: string };

export class LedgerAdmin extends DurableObject<ManagedEnv> {
  constructor(ctx: DurableObjectState, env: ManagedEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => migrate(ctx.storage.sql, LEDGER_SCHEMA));
    });
  }

  /** Set while an alarm is on its way for the rollup, so a burst of writes arms one. */
  protected rollupArmed = false;

  /** One transaction; what it marked for the rollup arms the alarm in the same breath (no await
   * in between, so it commits with the writes). */
  protected tx<T>(fn: (sql: SqlStorage) => T): T {
    const answer = this.ctx.storage.transactionSync(() => fn(this.ctx.storage.sql));
    if (!this.rollupArmed && this.#rollupOn() && rollupPending(this.ctx.storage.sql) > 0) {
      const name = this.ctx.id.name;
      // The refund limits' instance has no entries, and a ledger only ever has its account's name.
      if (name && isCanonicalAccountIdentifier(name)) {
        this.ctx.storage.transactionSync(() => rememberAccount(this.ctx.storage.sql, name));
        this.rollupArmed = true;
        void this.ctx.storage.setAlarm(Date.now() + ROLLUP_DELAY_MS);
      }
    }
    return answer;
  }

  #rollupOn() {
    return this.env.ADMIN_BILLING === 'on' && Boolean(this.env.REVENUE);
  }

  /** Whether days still wait for the rollup, so the alarm should come back for them. */
  protected rollupWaiting() {
    return this.#rollupOn() && rollupPending(this.ctx.storage.sql) > 0;
  }

  /** Pushes the marked days to D1, outside any transaction. A failed push keeps its marks and
   * never throws: an outage delays the rollup and touches nothing else. True when it failed. */
  protected async pushRollup(): Promise<boolean> {
    const db = this.env.REVENUE;
    if (!db || !this.#rollupOn()) return false;
    const sql = this.ctx.storage.sql;
    const batch = this.ctx.storage.transactionSync(() => rollupBatch(sql, ROLLUP_BATCH_DAYS));
    if (!batch) return false;
    try {
      await db.batch(rollupStatements(db, batch));
    } catch (e: any) {
      const message = String(e?.message ?? e).slice(0, 200);
      console.error(JSON.stringify({ event: 'billing.rollup', message }));
      return true;
    }
    this.ctx.storage.transactionSync(() => rollupDone(sql, batch.marks));
    return false;
  }

  /** Marks every day to go to the rollup again: the backfill, and the way to rebuild it. */
  rollupRebuild() {
    this.tx((sql) => markAllDays(sql));
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

  /** What Stripe says is refunded of `topUp` in all; answers the refunds still open on it,
   * which only Stripe can settle, or null for a top-up this ledger does not know. */
  stripeRefunded(topUp: string, total: number): string[] | null {
    return this.tx((sql) => {
      if (!sql.exec('SELECT 1 FROM top_ups WHERE key = ?', topUp).toArray().length) return null;
      stripeRefunded(sql, topUp, total, Date.now());
      return sql
        .exec<{ id: string }>(
          "SELECT id FROM refunds WHERE top_up = ? AND status = 'open' AND origin = 'operator'",
          topUp,
        )
        .toArray()
        .map((r) => r.id);
    });
  }

  disputeOpened(d: DisputeEvent) {
    this.tx((sql) => openDispute(sql, d, Date.now()));
  }

  /** Answers the runs the credit coming back lets go on. */
  disputeClosed(d: DisputeEvent, status: string) {
    return this.tx((sql) => {
      closeDispute(sql, d, status, Date.now());
      return { resume: this.takePaused(sql) };
    });
  }

  pauseBilling(pause: { reason: string; by: string } | null) {
    this.tx((sql) => setBillingPaused(sql, pause && { ...pause, at: Date.now() }));
  }

  /** What the nightly reconcile compares with Stripe. Read-only. */
  reconcileState() {
    return this.tx((sql) => ({
      customer: billingRow(sql).customer,
      top_ups: reconcileRows(sql),
      rollup_pending: rollupPending(sql),
    }));
  }

  cancelTopUp(key: string) {
    this.tx((sql) => cancelTopUp(sql, key, Date.now()));
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
