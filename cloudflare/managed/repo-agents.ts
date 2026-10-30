// One repository's managed agents, in a SQLite Durable Object (one per repository): which
// agents are on, the platform connection made at enable time (the scoped repository token and
// the webhook's signing secret, both minted by the platform for this client) and every run.
// A run is keyed by (agent, change, head), so one head gets one run per agent however often
// its events arrive; a newer head on the same change supersedes the older runs.
import { DurableObject } from 'cloudflare:workers';
import type {
  ManagedAgentId,
  ManagedRun,
  RunFinding,
  RunStatus,
} from '../../shared/managed-agents';
import type { ManagedEnv } from './config';
import {
  type Connection,
  readConnection,
  retainConnection,
  signatureMatches,
  writeConnection,
} from './repo-connection';
import { agentSummary, clearRepository, listRuns, runById, runFindings } from './repo-runs';
import { migrate, REPO_SCHEMA } from './schema';

export type { Connection } from './repo-connection';

const OPEN: RunStatus[] = ['queued', 'running', 'paused'];
const OPEN_SQL = `('${OPEN.join("','")}')`;

export interface Claim {
  run: string;
  attempt: number;
  created: boolean;
  /** Still waiting for its Workflow instance (a lost start is retried). */
  queued: boolean;
  superseded: string[];
}
export type PostedFinding = RunFinding;

const shortAgent: Record<ManagedAgentId, string> = {
  'code-review': 'cr',
  'security-review': 'sr',
  'slop-review': 'sl',
};

export class RepoAgents extends DurableObject<ManagedEnv> {
  constructor(ctx: DurableObjectState, env: ManagedEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => migrate(ctx.storage.sql, REPO_SCHEMA));
    });
  }

  get #sql() {
    return this.ctx.storage.sql;
  }

  #tx<T>(fn: (sql: SqlStorage) => T): T {
    return this.ctx.storage.transactionSync(() => fn(this.#sql));
  }

  /** The connection with its token and hook secret opened (they are sealed at rest). */
  connection(): Promise<Connection | null> {
    return readConnection(this.#sql, this.env);
  }

  link(repo: string, c: Connection) {
    return writeConnection(this.#sql, this.env, repo, c);
  }

  /** Keeps only the repo.deleted hook (see retainConnection). */
  retain(repo: string, hook: { id: number; secret: string }) {
    return retainConnection(this.#sql, this.env, repo, hook);
  }

  hasConnection(): boolean {
    return this.#sql.exec('SELECT 1 FROM connection WHERE id = 1').toArray().length > 0;
  }

  /** The repository was deleted: its runs, findings, switches and connection go, in one
   * transaction. Its workflows find no run and stop at their next step. */
  purge() {
    this.#tx(clearRepository);
  }

  /** Forgets the connection (its token and webhook were revoked, or the platform refused them). */
  unlink() {
    this.#sql.exec('DELETE FROM connection');
  }

  /** Whether `signature` (`sha256=<hex>`) is this repository's webhook signature of `body`. */
  async verify(body: string, signature: string): Promise<boolean> {
    const secret = (await this.connection().catch(() => null))?.hook_secret;
    return Boolean(secret) && signatureMatches(secret as string, body, signature);
  }

  enabled(): ManagedAgentId[] {
    return this.#sql
      .exec<{ agent: ManagedAgentId }>('SELECT agent FROM agents WHERE enabled = 1 ORDER BY agent')
      .toArray()
      .map((r) => r.agent);
  }

  /** Turns an agent on or off; off cancels its open runs (their workflows stop at the next step). */
  setEnabled(agent: ManagedAgentId, enabled: boolean, by: string): string[] {
    return this.#tx((sql) => {
      sql.exec(
        `INSERT INTO agents (agent, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(agent) DO UPDATE SET enabled = excluded.enabled,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        agent,
        enabled ? 1 : 0,
        Date.now(),
        by,
      );
      if (enabled) return [];
      return sql
        .exec<{ id: string }>(
          `UPDATE runs SET status = 'cancelled', finished_at = ?, error = 'Agent disabled'
           WHERE agent = ? AND status IN ${OPEN_SQL} RETURNING id`,
          Date.now(),
          agent,
        )
        .toArray()
        .map((r) => r.id);
    });
  }

  /** The run for (agent, change, head), made once; older open heads of the change are superseded. */
  claim(
    repo: string,
    agent: ManagedAgentId,
    change: number,
    head: string,
    choice: { harness: string; provider: string; model: string },
  ): Claim | null {
    return this.#tx((sql) => {
      const on = sql
        .exec('SELECT 1 FROM agents WHERE agent = ? AND enabled = 1', agent)
        .toArray().length;
      if (!on) return null;
      const existing = sql
        .exec<{ id: string; attempt: number; status: RunStatus }>(
          'SELECT id, attempt, status FROM runs WHERE agent = ? AND change = ? AND head = ?',
          agent,
          change,
          head,
        )
        .toArray()[0];
      if (existing)
        return {
          run: existing.id,
          attempt: existing.attempt,
          created: false,
          queued: existing.status === 'queued',
          superseded: [],
        };
      const now = Date.now();
      const superseded = sql
        .exec<{ id: string }>(
          `UPDATE runs SET status = 'superseded', finished_at = ?, error = 'A newer push replaced this head'
           WHERE agent = ? AND change = ? AND head <> ? AND status IN ${OPEN_SQL} RETURNING id`,
          now,
          agent,
          change,
          head,
        )
        .toArray()
        .map((r) => r.id);
      const run = `${repo}-${shortAgent[agent]}-${change}-${head.slice(0, 12)}`;
      sql.exec(
        `INSERT INTO runs (id, repo, agent, change, head, status, harness, provider, model, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        run,
        repo,
        agent,
        change,
        head,
        choice.harness,
        choice.provider,
        choice.model,
        now,
      );
      return { run, attempt: 1, created: true, queued: true, superseded };
    });
  }

  /** Why a workflow attempt must stop, or null while it is the run's current attempt. */
  stopReason(run: string, attempt: number): string | null {
    const row = this.#sql
      .exec<{ status: RunStatus; attempt: number; enabled: number | null }>(
        `SELECT r.status, r.attempt, a.enabled FROM runs r LEFT JOIN agents a ON a.agent = r.agent
         WHERE r.id = ?`,
        run,
      )
      .toArray()[0];
    if (!row) return 'unknown';
    if (row.attempt !== attempt) return 'stale';
    if (row.enabled !== 1) return 'cancelled';
    if (row.status !== 'queued' && row.status !== 'running') return row.status;
    return null;
  }

  start(run: string, attempt: number): boolean {
    return (
      this.#sql
        .exec(
          `UPDATE runs SET status = 'running' WHERE id = ? AND attempt = ? AND status IN ('queued','running') RETURNING id`,
          run,
          attempt,
        )
        .toArray().length > 0
    );
  }

  pause(run: string, attempt: number) {
    this.#sql.exec(
      `UPDATE runs SET status = 'paused', error = 'Paused: no agent credit left'
       WHERE id = ? AND attempt = ? AND status IN ('queued','running')`,
      run,
      attempt,
    );
  }

  /** A paused run's next attempt, or null when it no longer should run. */
  resume(
    run: string,
  ): { attempt: number; agent: ManagedAgentId; change: number; head: string } | null {
    return this.#tx((sql) => {
      const row = sql
        .exec<{ attempt: number; agent: ManagedAgentId; change: number; head: string }>(
          `UPDATE runs SET status = 'queued', attempt = attempt + 1, error = NULL
           WHERE id = ? AND status = 'paused'
             AND agent IN (SELECT agent FROM agents WHERE enabled = 1)
           RETURNING attempt, agent, change, head`,
          run,
        )
        .toArray()[0];
      return row ?? null;
    });
  }

  recordCall(run: string, inputTokens: number, outputTokens: number, charged: number) {
    this.#sql.exec(
      `UPDATE runs SET calls = calls + 1, input_tokens = input_tokens + ?,
         output_tokens = output_tokens + ?, charged_microusd = charged_microusd + ? WHERE id = ?`,
      inputTokens,
      outputTokens,
      charged,
      run,
    );
  }

  /** The model a run is using now; `fallback` says why it is not the configured one. */
  useModel(
    run: string,
    choice: { harness: string; provider: string; model: string },
    fallback: string | null,
  ) {
    this.#sql.exec(
      'UPDATE runs SET harness = ?, provider = ?, model = ?, fallback = COALESCE(?, fallback) WHERE id = ?',
      choice.harness,
      choice.provider,
      choice.model,
      fallback ? fallback.slice(0, 300) : null,
      run,
    );
  }

  recordContainer(run: string, seconds: number, charged: number) {
    this.#sql.exec(
      `UPDATE runs SET container_seconds = container_seconds + ?,
         charged_microusd = charged_microusd + ? WHERE id = ?`,
      seconds,
      charged,
      run,
    );
  }

  finish(
    run: string,
    attempt: number,
    status: 'passed' | 'findings' | 'failed',
    outcome: {
      value?: string | null;
      summary?: string | null;
      findings?: PostedFinding[];
      withheld?: number;
      error?: string | null;
    },
  ) {
    const findings = outcome.findings ?? [];
    this.#sql.exec(
      `UPDATE runs SET status = ?, value = ?, summary = ?, findings = ?, findings_json = ?,
         withheld = ?, error = ?, finished_at = ?
       WHERE id = ? AND attempt = ? AND status IN ('queued','running')`,
      status,
      outcome.value ?? null,
      outcome.summary ?? null,
      findings.length,
      JSON.stringify(findings),
      outcome.withheld ?? 0,
      outcome.error ? outcome.error.slice(0, 300) : null,
      Date.now(),
      run,
      attempt,
    );
  }

  /** A run's posted findings (the detail page). */
  findings(id: string): PostedFinding[] {
    return runFindings(this.#sql, id);
  }

  run(id: string): ManagedRun | null {
    return runById(this.#sql, id);
  }

  runs(agent: string | null, limit: number): ManagedRun[] {
    return listRuns(this.#sql, agent, limit);
  }

  /** Each agent's switch and newest run. */
  summary() {
    return agentSummary(this.#sql);
  }
}

export const repoStub = (env: ManagedEnv, repo: string) =>
  env.REPOS.get(env.REPOS.idFromName(repo));
