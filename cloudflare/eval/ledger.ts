// The eval Worker's spend authority: one Durable Object holds every model request's
// reservation, so the cap holds across arms, requests and concurrent callers. A request
// is admitted only if settled spend plus open reservations plus its projected cost stays
// within the cap; unsettled reservations (a crashed request) keep counting.
import { DurableObject } from 'cloudflare:workers';

/** The code-level ceiling: configuration can lower the cap, never raise it. */
export const HARD_CAP_MICROUSD = 5_000_000;

export type Admission = { admitted: boolean; committed_microusd: number; cap_microusd: number };
export type Totals = {
  cap_microusd: number;
  settled_microusd: number;
  open_reservations_microusd: number;
  requests: number;
  refused: number;
};

export function capOf(configured: string | undefined) {
  const value = Number(configured);
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, HARD_CAP_MICROUSD) : 0;
}

export class SpendLedger extends DurableObject<{ EVAL_SPEND_CAP_MICROUSD?: string }> {
  constructor(ctx: DurableObjectState, env: { EVAL_SPEND_CAP_MICROUSD?: string }) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS spend(
        id TEXT PRIMARY KEY, run TEXT NOT NULL, reserved INTEGER NOT NULL,
        actual INTEGER, status TEXT NOT NULL, at INTEGER NOT NULL)`,
    );
  }

  #cap() {
    return capOf(this.env.EVAL_SPEND_CAP_MICROUSD);
  }

  #committed() {
    const row = this.ctx.storage.sql
      .exec<{ total: number }>(
        `SELECT COALESCE(SUM(CASE status WHEN 'settled' THEN actual ELSE reserved END), 0) AS total
         FROM spend WHERE status IN ('reserved', 'settled')`,
      )
      .one();
    return row.total;
  }

  /** Admits a request whose projected cost fits under the cap, recording the reservation. */
  reserve(id: string, run: string, projected: number): Admission {
    const cap = this.#cap();
    const committed = this.#committed();
    const amount = Math.max(0, Math.ceil(projected));
    if (committed + amount > cap) {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO spend VALUES (?, ?, ?, 0, 'refused', ?)`,
        id,
        run,
        amount,
        Date.now(),
      );
      return { admitted: false, committed_microusd: committed, cap_microusd: cap };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO spend VALUES (?, ?, ?, NULL, 'reserved', ?)`,
      id,
      run,
      amount,
      Date.now(),
    );
    return { admitted: true, committed_microusd: committed + amount, cap_microusd: cap };
  }

  /** Replaces a reservation with the provider-reported cost (zero when nothing was billed). */
  settle(id: string, actual: number) {
    this.ctx.storage.sql.exec(
      `UPDATE spend SET actual = ?, status = 'settled' WHERE id = ? AND status = 'reserved'`,
      Math.max(0, Math.ceil(actual)),
      id,
    );
  }

  totals(): Totals {
    const rows = this.ctx.storage.sql
      .exec<{ status: string; n: number; reserved: number; actual: number }>(
        `SELECT status, COUNT(*) AS n, COALESCE(SUM(reserved), 0) AS reserved,
                COALESCE(SUM(actual), 0) AS actual FROM spend GROUP BY status`,
      )
      .toArray();
    const of = (status: string) => rows.find((r) => r.status === status);
    return {
      cap_microusd: this.#cap(),
      settled_microusd: of('settled')?.actual ?? 0,
      open_reservations_microusd: of('reserved')?.reserved ?? 0,
      requests: (of('settled')?.n ?? 0) + (of('reserved')?.n ?? 0),
      refused: of('refused')?.n ?? 0,
    };
  }
}
