// A repository's runs as RepoAgents stores them. Reads: one run, a page of runs, a run's posted
// findings and each agent's switch with its newest run. Writes: claiming a head.
import type {
  ManagedAgentId,
  ManagedRun,
  RunFinding,
  RunStatus,
} from '../../shared/managed-agents';
import { AUTOMATION_PAUSED, notReviewed } from './config';

type RunRow = Omit<ManagedRun, 'cost_usd'> & {
  charged_microusd: number;
  attempt: number;
  findings_json: string | null;
};

function toRun(row: RunRow): ManagedRun {
  const { charged_microusd, attempt: _attempt, findings_json: _findings, ...rest } = row;
  return { ...rest, cost_usd: charged_microusd / 1_000_000 };
}

export function runFindings(sql: SqlStorage, id: string): RunFinding[] {
  const row = sql
    .exec<{ findings_json: string | null }>('SELECT findings_json FROM runs WHERE id = ?', id)
    .toArray()[0];
  return row?.findings_json ? (JSON.parse(row.findings_json) as RunFinding[]) : [];
}

export function runById(sql: SqlStorage, id: string): ManagedRun | null {
  const row = sql.exec<RunRow>('SELECT * FROM runs WHERE id = ?', id).toArray()[0];
  return row ? toRun(row) : null;
}

export function listRuns(sql: SqlStorage, agent: string | null, limit: number): ManagedRun[] {
  const n = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  const rows = agent
    ? sql
        .exec<RunRow>(
          'SELECT * FROM runs WHERE agent = ? ORDER BY created_at DESC, id LIMIT ?',
          agent,
          n,
        )
        .toArray()
    : sql.exec<RunRow>('SELECT * FROM runs ORDER BY created_at DESC, id LIMIT ?', n).toArray();
  return rows.map(toRun);
}

export function agentSummary(
  sql: SqlStorage,
): { agent: string; enabled: boolean; last_run: ManagedRun | null }[] {
  return sql
    .exec<{ agent: string; enabled: number }>('SELECT agent, enabled FROM agents')
    .toArray()
    .map((s) => ({
      agent: s.agent,
      enabled: s.enabled === 1,
      last_run: listRuns(sql, s.agent, 1)[0] ?? null,
    }));
}

/** A deleted repository's state: its runs (with their findings), switches and connection. */
export function clearRepository(sql: SqlStorage) {
  for (const table of ['runs', 'agents', 'connection']) sql.exec(`DELETE FROM ${table}`);
}

const OPEN: RunStatus[] = ['queued', 'running', 'paused'];
export const OPEN_SQL = `('${OPEN.join("','")}')`;

export interface Claim {
  run: string;
  attempt: number;
  created: boolean;
  /** Still waiting for its Workflow instance (a lost start is retried). */
  queued: boolean;
  /** A new attempt of a run a pause stopped: paid for again, unlike a start sent twice. */
  restarted?: boolean;
  superseded: string[];
}

const shortAgent: Record<ManagedAgentId, string> = {
  'code-review': 'cr',
  'security-review': 'sr',
  'slop-review': 'sl',
  'intent-drift': 'id',
};

/** The run for (agent, change, head), made once; older open heads of the change are superseded. */
export function claimRun(
  sql: SqlStorage,
  repo: string,
  agent: ManagedAgentId,
  change: number,
  head: string,
  choice: { harness: string; provider: string; model: string },
): Claim | null {
  const on = sql
    .exec('SELECT 1 FROM agents WHERE agent = ? AND enabled = 1', agent)
    .toArray().length;
  if (!on) return null;
  const existing = sql
    .exec<{ id: string; attempt: number; status: RunStatus; error: string | null }>(
      'SELECT id, attempt, status, error FROM runs WHERE agent = ? AND change = ? AND head = ?',
      agent,
      change,
      head,
    )
    .toArray()[0];
  // A pause stopped this head before it had an answer: it gets another try.
  if (existing?.error === notReviewed(AUTOMATION_PAUSED)) {
    sql.exec(
      `UPDATE runs SET status = 'queued', attempt = attempt + 1, error = NULL, finished_at = NULL
       WHERE id = ?`,
      existing.id,
    );
    const attempt = existing.attempt + 1;
    return {
      run: existing.id,
      attempt,
      created: false,
      queued: true,
      restarted: true,
      superseded: [],
    };
  }
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
}
