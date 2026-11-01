// The superfan's durable state in one SQLite Durable Object: findings (deduplicated by the
// rules that fired), latency baselines, the daily spend counter, the run lease and the
// heartbeat. Every method is one synchronous transaction, so overlapping runs cannot double-spend
// or double-mail.
import { DurableObject } from 'cloudflare:workers';
import type { SuperfanEnv } from './config';
import { type DeployRow, insertDeploy, latestRevision, recentDeploys } from './ledger-deploys';
import {
  type Level,
  type NarrativeStatus,
  type Observation,
  type Observed,
  observeProblem,
  resolveAbsent,
} from './ledger-findings';
import {
  claimNotice,
  claimUrgent,
  markNotified,
  releaseNotice,
  releaseUrgent,
} from './ledger-notice';
import { migrate } from './ledger-schema';
import { reserveSpend, settleSpend, spendToday } from './ledger-spend';
import { ingestRows, markWindow, tailWindow } from './ledger-tail';
import { compareReleases } from './release';
import type { Baselines } from './signals';
import type { TailRow } from './tail';

const LEASE_MS = 15 * 60_000;
const EWMA_WEIGHT = 0.2;

export type { Level, NarrativeStatus, Observation, Observed } from './ledger-findings';
export interface FindingRow {
  id: number;
  dedup_key: string;
  component: string;
  kind: string;
  level: Level;
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
  notified_at: string | null;
  /** The release it was first seen on, and the latest; null when neither was known. */
  revision: string | null;
  last_revision: string | null;
}

export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const iso = (ms: unknown) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);
const finding = (r: Record<string, any>) =>
  ({
    ...r,
    signals: JSON.parse(r.signals),
    narrative: r.narrative ? JSON.parse(r.narrative) : null,
    first_seen: iso(r.first_seen),
    last_seen: iso(r.last_seen),
    resolved_at: iso(r.resolved_at),
    notified_at: iso(r.notified_at),
  }) as FindingRow;

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

  marks(start: number) {
    return markWindow(this.ctx.storage.sql, start);
  }

  /** One row of the deploy ledger; a repeat changes nothing. */
  recordDeploy(row: DeployRow) {
    this.#tx((sql) => insertDeploy(sql, row));
  }

  deploys(limit: number) {
    return recentDeploys(this.ctx.storage.sql, limit);
  }

  latestRevision() {
    return latestRevision(this.ctx.storage.sql);
  }

  /** This release against the one before, from the minutes the tail kept. */
  compareReleases(now: number) {
    return compareReleases(this.ctx.storage.sql, now);
  }

  /** A quick pass finished; a full pass's beat is its finished run. */
  beat(now: number) {
    this.#tx((sql) => {
      sql.exec(
        "INSERT INTO beats (name, at) VALUES ('quick', ?) ON CONFLICT(name) DO UPDATE SET at = excluded.at",
        now,
      );
    });
  }

  /** When a pass last ran to its end: what the dead-man reads. */
  beats() {
    const sql = this.ctx.storage.sql;
    return {
      full_at: sql
        .exec<{ at: number | null }>(
          "SELECT MAX(finished_at) AS at FROM runs WHERE outcome IN ('ok', 'telemetry_failed')",
        )
        .one().at,
      quick_at:
        sql.exec<{ at: number }>("SELECT at FROM beats WHERE name = 'quick'").toArray()[0]?.at ??
        null,
    };
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
    return this.#tx((sql) => observeProblem(sql, o, now));
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

  /** Resolves open findings not seen this run, of rules that were evaluated. */
  resolveAbsent(evaluated: string[], present: string[], now: number) {
    return this.#tx((sql) => resolveAbsent(sql, evaluated, present, now));
  }

  /** Reserves a worst-case call cost against today's cap; null when it would exceed it. */
  reserve(now: number, amount: number, cap: number): string | null {
    return this.#tx((sql) => reserveSpend(sql, utcDay(now), amount, cap));
  }

  /** Replaces a reservation with the actual cost (0 releases it). Settles only once. */
  settle(id: string, actual: number) {
    this.#tx((sql) => settleSpend(sql, id, actual));
  }

  findings(status: 'open' | 'resolved' | 'all', limit: number): FindingRow[] {
    const rows = this.ctx.storage.sql
      .exec<Record<string, any>>(
        `SELECT * FROM findings ${status === 'all' ? '' : 'WHERE status = ?'} ORDER BY last_seen DESC, id DESC LIMIT ?`,
        ...(status === 'all' ? [limit] : [status, limit]),
      )
      .toArray();
    return rows.map(finding);
  }

  /** The next digest's findings, counted against today's email cap; none at the cap. */
  claimNotice(now: number, cap: number, limit: number): FindingRow[] {
    return this.#tx((sql) => claimNotice(sql, utcDay(now), cap, limit)).map(finding);
  }

  releaseNotice(now: number) {
    this.#tx((sql) => releaseNotice(sql, utcDay(now)));
  }

  /** Urgent findings this pass may mail, within each signal's limit. */
  claimUrgent(now: number, limit: number): (FindingRow & { seq: number })[] {
    return this.#tx((sql) => claimUrgent(sql, utcDay(now), now, limit)).map(
      (row) => ({ ...finding(row), seq: row.seq }) as FindingRow & { seq: number },
    );
  }

  releaseUrgent(keys: string[]) {
    this.#tx((sql) => releaseUrgent(sql, keys));
  }

  markNotified(ids: number[], now: number) {
    this.#tx((sql) => markNotified(sql, ids, now));
  }

  status(now: number) {
    const sql = this.ctx.storage.sql;
    const runs = sql.exec('SELECT * FROM runs ORDER BY id DESC LIMIT 5').toArray();
    const open = sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM findings WHERE status = 'open'")
      .one().n;
    return {
      spend: spendToday(sql, utcDay(now)),
      open_findings: open,
      runs: runs.map((r) => ({
        ...r,
        started_at: iso(r.started_at),
        finished_at: iso(r.finished_at),
      })),
    };
  }
}
