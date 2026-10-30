// Reads of a repository's runs as RepoAgents stores them: one run, a page of runs, a run's
// posted findings and each agent's switch with its newest run.
import type { ManagedRun, RunFinding } from '../../shared/managed-agents';

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
