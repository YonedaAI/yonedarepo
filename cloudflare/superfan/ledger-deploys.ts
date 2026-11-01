// The deploy ledger inside Superfan's: what ran when, written by `cargo xtask deploy` and
// `rollback` (xtask/src/deploy_ledger.rs). SQL for the ledger's methods, each one transaction. A
// row repeated after a lost answer is ignored, and the table keeps the newest KEEP rows.
const REVISION = /^[0-9a-f]{40}$/;
const WHO = /^[A-Za-z0-9 ._:-]{1,64}$/;
const KEEP = 1_000;

export interface DeployRow {
  revision: string;
  env: string;
  who: string;
  kind: 'deploy' | 'rollback';
  outcome: 'ok' | 'failed';
  started_at: number;
  finished_at: number;
}

const time = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** A row from `body`, or null. Only this environment's Superfan takes its environment's rows. */
export function parseDeploy(body: unknown, script: string): DeployRow | null {
  const row = (body ?? {}) as Partial<Record<keyof DeployRow, unknown>>;
  const { revision, env, who, kind, outcome, started_at: started, finished_at: finished } = row;
  if (typeof revision !== 'string' || !REVISION.test(revision)) return null;
  if (typeof env !== 'string' || script !== `yonedarepo-${env}-platform`) return null;
  if (typeof who !== 'string' || !WHO.test(who)) return null;
  if (kind !== 'deploy' && kind !== 'rollback') return null;
  if (outcome !== 'ok' && outcome !== 'failed') return null;
  if (!time(started) || !time(finished) || finished < started) return null;
  return { revision, env, who, kind, outcome, started_at: started, finished_at: finished };
}

export function insertDeploy(sql: SqlStorage, row: DeployRow) {
  sql.exec(
    `INSERT OR IGNORE INTO deploys (revision, env, who, kind, outcome, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.revision,
    row.env,
    row.who,
    row.kind,
    row.outcome,
    row.started_at,
    row.finished_at,
  );
  sql.exec(
    'DELETE FROM deploys WHERE id <= (SELECT id FROM deploys ORDER BY id DESC LIMIT 1 OFFSET ?)',
    KEEP,
  );
}

export const recentDeploys = (sql: SqlStorage, limit: number) =>
  sql
    .exec<Record<string, SqlStorageValue>>(
      'SELECT * FROM deploys ORDER BY finished_at DESC, id DESC LIMIT ?',
      limit,
    )
    .toArray() as unknown as (DeployRow & { id: number })[];

/** The newest revision that finished deploying: what a finding is tied to with no `/health`. */
export const latestRevision = (sql: SqlStorage) =>
  sql
    .exec<{ revision: string }>(
      "SELECT revision FROM deploys WHERE outcome = 'ok' ORDER BY finished_at DESC, id DESC LIMIT 1",
    )
    .toArray()[0]?.revision ?? null;
