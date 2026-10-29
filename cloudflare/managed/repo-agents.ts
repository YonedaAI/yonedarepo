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
import { migrate, REPO_SCHEMA } from './schema';

const OPEN: RunStatus[] = ['queued', 'running', 'paused'];
const OPEN_SQL = `('${OPEN.join("','")}')`;

export type Connection = {
  account: string;
  token_name: string;
  token: string;
  hook_id: number;
  hook_secret: string;
};
export interface Claim {
  run: string;
  attempt: number;
  created: boolean;
  /** Still waiting for its Workflow instance (a lost start is retried). */
  queued: boolean;
  superseded: string[];
}
type RunRow = Omit<ManagedRun, 'cost_usd'> & {
  charged_microusd: number;
  attempt: number;
  findings_json: string | null;
};
export type PostedFinding = RunFinding;

const shortAgent: Record<ManagedAgentId, string> = {
  'code-review': 'cr',
  'security-review': 'sr',
  'slop-review': 'sl',
};

function toRun(row: RunRow): ManagedRun {
  const { charged_microusd, attempt: _attempt, findings_json: _findings, ...rest } = row;
  return { ...rest, cost_usd: charged_microusd / 1_000_000 };
}

async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

  connection(): Connection | null {
    return (
      this.#sql
        .exec<Connection>(
          'SELECT account, token_name, token, hook_id, hook_secret FROM connection WHERE id = 1',
        )
        .toArray()[0] ?? null
    );
  }

  link(c: Connection) {
    this.#sql.exec(
      `INSERT INTO connection (id, account, token_name, token, hook_id, hook_secret, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET account = excluded.account, token_name = excluded.token_name,
         token = excluded.token, hook_id = excluded.hook_id, hook_secret = excluded.hook_secret`,
      c.account,
      c.token_name,
      c.token,
      c.hook_id,
      c.hook_secret,
      Date.now(),
    );
  }

  /** Forgets the connection (the platform answered that its token is gone). */
  unlink() {
    this.#sql.exec('DELETE FROM connection');
  }

  /** Whether `signature` (`sha256=<hex>`) is this repository's webhook signature of `body`. */
  async verify(body: string, signature: string): Promise<boolean> {
    const secret = this.connection()?.hook_secret;
    if (!secret || !signature.startsWith('sha256=')) return false;
    const expected = new TextEncoder().encode(`sha256=${await hmacHex(secret, body)}`);
    const supplied = new TextEncoder().encode(signature);
    return expected.length === supplied.length && crypto.subtle.timingSafeEqual(expected, supplied);
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
      findings?: PostedFinding[];
      withheld?: number;
      error?: string | null;
    },
  ) {
    const findings = outcome.findings ?? [];
    this.#sql.exec(
      `UPDATE runs SET status = ?, value = ?, findings = ?, findings_json = ?, withheld = ?,
         error = ?, finished_at = ?
       WHERE id = ? AND attempt = ? AND status IN ('queued','running')`,
      status,
      outcome.value ?? null,
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
    const row = this.#sql
      .exec<{ findings_json: string | null }>('SELECT findings_json FROM runs WHERE id = ?', id)
      .toArray()[0];
    return row?.findings_json ? (JSON.parse(row.findings_json) as PostedFinding[]) : [];
  }

  run(id: string): ManagedRun | null {
    const row = this.#sql.exec<RunRow>('SELECT * FROM runs WHERE id = ?', id).toArray()[0];
    return row ? toRun(row) : null;
  }

  runs(agent: string | null, limit: number): ManagedRun[] {
    const n = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const rows = agent
      ? this.#sql
          .exec<RunRow>(
            'SELECT * FROM runs WHERE agent = ? ORDER BY created_at DESC, id LIMIT ?',
            agent,
            n,
          )
          .toArray()
      : this.#sql
          .exec<RunRow>('SELECT * FROM runs ORDER BY created_at DESC, id LIMIT ?', n)
          .toArray();
    return rows.map(toRun);
  }

  /** Each agent's switch and newest run. */
  summary(): { agent: string; enabled: boolean; last_run: ManagedRun | null }[] {
    const switches = this.#sql
      .exec<{ agent: string; enabled: number }>('SELECT agent, enabled FROM agents')
      .toArray();
    return switches.map((s) => ({
      agent: s.agent,
      enabled: s.enabled === 1,
      last_run: this.runs(s.agent, 1)[0] ?? null,
    }));
  }
}

export const repoStub = (env: ManagedEnv, repo: string) =>
  env.REPOS.get(env.REPOS.idFromName(repo));
