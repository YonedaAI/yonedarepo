// The superfan's durable state in one SQLite Durable Object: findings (deduplicated by the
// rules that fired), latency baselines, the daily spend counter and the run lease. Every
// method is one synchronous transaction, so overlapping runs cannot double-spend.
import { DurableObject } from 'cloudflare:workers';
import type { SuperfanEnv } from './config';
import { migrate } from './ledger-schema';
import { ingestRows, tailWindow } from './ledger-tail';
import type { Baselines } from './signals';
import type { TailRow } from './tail';

const LEASE_MS = 15 * 60_000;
/** A problem that returns this soon after resolving reopens its finding instead of a new one. */
const REOPEN_MS = 6 * 60 * 60_000;
const EWMA_WEIGHT = 0.2;

export type NarrativeStatus =
  | 'pending'
  | 'written'
  | 'deterministic'
  | 'budget_exhausted'
  | 'model_failed';
export interface Observation {
  key: string;
  component: string;
  kind: 'anomaly' | 'telemetry';
  signals: unknown;
  summary: string;
}
export interface Observed {
  id: number;
  action: 'new' | 'repeat' | 'reopened';
  needsNarrative: boolean;
}
export interface FindingRow {
  id: number;
  dedup_key: string;
  component: string;
  kind: string;
  status: string;
  signals: unknown;
  summary: string;
  narrative: unknown;
  narrative_status: NarrativeStatus;
  model: string | null;
  cost_microusd: number;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  resolved_at: string | null;
}

export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const iso = (ms: unknown) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);

export class SuperfanLedger extends DurableObject<SuperfanEnv> {
  constructor(ctx: DurableObjectState, env: SuperfanEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => migrate(ctx.storage.sql));
    });
  }

  #tx<T>(fn: (sql: SqlStorage) => T): T {
    return this.ctx.storage.transactionSync(() => fn(this.ctx.storage.sql));
  }

  /** Merges one tail batch's counters. */
  ingest(rows: TailRow[], now: number) {
    this.#tx((sql) => ingestRows(sql, rows, now));
  }

  tailStats(start: number, end: number) {
    return tailWindow(this.ctx.storage.sql, start, end);
  }

  /** Starts a run unless another one holds an unexpired lease. */
  startRun(now: number): number | null {
    return this.#tx((sql) => {
      const lease = sql
        .exec<{ expires_at: number }>("SELECT expires_at FROM run_lease WHERE name = 'watch'")
        .toArray()[0];
      if (lease && lease.expires_at > now) return null;
      const id = sql
        .exec<{ id: number }>('INSERT INTO runs (started_at) VALUES (?) RETURNING id', now)
        .one().id;
      sql.exec(
        "INSERT INTO run_lease (name, run_id, expires_at) VALUES ('watch', ?, ?) ON CONFLICT(name) DO UPDATE SET run_id = excluded.run_id, expires_at = excluded.expires_at",
        id,
        now + LEASE_MS,
      );
      return id;
    });
  }

  finishRun(id: number, outcome: string, anomalies: number, modelCalls: number, now: number) {
    this.#tx((sql) => {
      sql.exec(
        'UPDATE runs SET finished_at = ?, outcome = ?, anomalies = ?, model_calls = ? WHERE id = ?',
        now,
        outcome,
        anomalies,
        modelCalls,
        id,
      );
      sql.exec("DELETE FROM run_lease WHERE name = 'watch' AND run_id = ?", id);
    });
  }

  baselines(): Baselines {
    const out: Baselines = {};
    for (const row of this.ctx.storage.sql
      .exec<{ key: string; value: number; samples: number }>(
        'SELECT key, value, samples FROM baselines',
      )
      .toArray())
      out[row.key] = { value: row.value, samples: row.samples };
    return out;
  }

  recordBaselines(samples: { key: string; value: number }[], now: number) {
    this.#tx((sql) => {
      for (const { key, value } of samples)
        sql.exec(
          `INSERT INTO baselines (key, value, samples, updated_at) VALUES (?, ?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET value = value * ? + excluded.value * ?,
             samples = samples + 1, updated_at = excluded.updated_at`,
          key,
          value,
          now,
          1 - EWMA_WEIGHT,
          EWMA_WEIGHT,
        );
    });
  }

  /** Records that a problem is present now; a known open problem is counted, not duplicated. */
  observe(o: Observation, now: number): Observed {
    return this.#tx((sql) => {
      const signals = JSON.stringify(o.signals);
      const open = sql
        .exec<{ id: number; narrative_status: NarrativeStatus }>(
          "SELECT id, narrative_status FROM findings WHERE dedup_key = ? AND status = 'open'",
          o.key,
        )
        .toArray()[0];
      const recent =
        open ??
        sql
          .exec<{ id: number; narrative_status: NarrativeStatus }>(
            "SELECT id, narrative_status FROM findings WHERE dedup_key = ? AND status = 'resolved' AND resolved_at >= ? ORDER BY resolved_at DESC LIMIT 1",
            o.key,
            now - REOPEN_MS,
          )
          .toArray()[0];
      if (recent) {
        sql.exec(
          "UPDATE findings SET status = 'open', resolved_at = NULL, occurrences = occurrences + 1, last_seen = ?, signals = ?, summary = ? WHERE id = ?",
          now,
          signals,
          o.summary,
          recent.id,
        );
        return {
          id: recent.id,
          action: open ? 'repeat' : 'reopened',
          needsNarrative: !['written', 'deterministic'].includes(recent.narrative_status),
        };
      }
      const status: NarrativeStatus = o.kind === 'anomaly' ? 'pending' : 'deterministic';
      const id = sql
        .exec<{ id: number }>(
          `INSERT INTO findings (dedup_key, component, kind, status, signals, summary, narrative_status, first_seen, last_seen)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?) RETURNING id`,
          o.key,
          o.component,
          o.kind,
          signals,
          o.summary,
          status,
          now,
          now,
        )
        .one().id;
      return { id, action: 'new', needsNarrative: status === 'pending' };
    });
  }

  annotate(id: number, status: NarrativeStatus, narrative: unknown, model: string, cost: number) {
    this.#tx((sql) => {
      sql.exec(
        'UPDATE findings SET narrative_status = ?, narrative = COALESCE(?, narrative), model = ?, cost_microusd = cost_microusd + ? WHERE id = ?',
        status,
        narrative === null ? null : JSON.stringify(narrative),
        model,
        cost,
        id,
      );
    });
  }

  /**
   * Resolves open findings that were not seen this run, but only when every rule in their
   * key (`component:ruleA+ruleB`) was evaluated; a rule whose source was down proves nothing.
   */
  resolveAbsent(evaluated: string[], present: string[], now: number) {
    return this.#tx((sql) => {
      let resolved = 0;
      for (const row of sql
        .exec<{ id: number; dedup_key: string }>(
          "SELECT id, dedup_key FROM findings WHERE status = 'open'",
        )
        .toArray()) {
        const [component, rules = ''] = row.dedup_key.split(':', 2);
        const checked = rules
          .split('+')
          .every((rule) => evaluated.includes(`${component}:${rule}`));
        if (checked && !present.includes(row.dedup_key)) {
          sql.exec(
            "UPDATE findings SET status = 'resolved', resolved_at = ? WHERE id = ?",
            now,
            row.id,
          );
          resolved++;
        }
      }
      return resolved;
    });
  }

  /** Reserves a worst-case call cost against today's cap; null when it would exceed it. */
  reserve(now: number, amount: number, cap: number): string | null {
    return this.#tx((sql) => {
      const day = utcDay(now);
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
    });
  }

  /** Replaces a reservation with the actual cost (0 releases it). Settles only once. */
  settle(id: string, actual: number) {
    this.#tx((sql) => {
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
    });
  }

  findings(status: 'open' | 'resolved' | 'all', limit: number): FindingRow[] {
    const rows = this.ctx.storage.sql
      .exec<Record<string, any>>(
        `SELECT * FROM findings ${status === 'all' ? '' : 'WHERE status = ?'} ORDER BY last_seen DESC, id DESC LIMIT ?`,
        ...(status === 'all' ? [limit] : [status, limit]),
      )
      .toArray();
    return rows.map((r) => ({
      ...r,
      signals: JSON.parse(r.signals),
      narrative: r.narrative ? JSON.parse(r.narrative) : null,
      first_seen: iso(r.first_seen),
      last_seen: iso(r.last_seen),
      resolved_at: iso(r.resolved_at),
    })) as FindingRow[];
  }

  status(now: number) {
    const sql = this.ctx.storage.sql;
    const spend = sql
      .exec(
        'SELECT day, reserved, settled, calls, refused FROM spend_days WHERE day = ?',
        utcDay(now),
      )
      .toArray()[0] ?? { day: utcDay(now), reserved: 0, settled: 0, calls: 0, refused: 0 };
    const runs = sql.exec('SELECT * FROM runs ORDER BY id DESC LIMIT 5').toArray();
    const open = sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM findings WHERE status = 'open'")
      .one().n;
    return {
      spend,
      open_findings: open,
      runs: runs.map((r) => ({
        ...r,
        started_at: iso(r.started_at),
        finished_at: iso(r.finished_at),
      })),
    };
  }
}
